#!/usr/bin/env node
'use strict';

/**
 * Run this first. It writes nothing and changes nothing — it just answers
 * "will the rest of this work, and where am I in the sequence?"
 *
 *   DATABASE_URL=... node bin/preflight.js
 */

const { Pool } = require('pg');

const OK = '  [ok]  ';
const WARN = '  [--]  ';
const FAIL = '  [XX]  ';

let failures = 0;
let warnings = 0;

function ok(msg) { console.log(OK + msg); }
function warn(msg) { console.log(WARN + msg); warnings++; }
function fail(msg) { console.log(FAIL + msg); failures++; }

async function main() {
  console.log('\n' + '='.repeat(64));
  console.log('TICKET IQ BILLING — PREFLIGHT');
  console.log('='.repeat(64) + '\n');

  // --- environment ---------------------------------------------------------
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 18) ok(`node ${process.versions.node}`);
  else fail(`node ${process.versions.node} — needs 18 or newer`);

  try {
    require.resolve('pg');
    ok('pg driver installed');
  } catch {
    fail('pg driver missing — run: npm install pg');
  }

  if (!process.env.DATABASE_URL) {
    fail('DATABASE_URL not set');
    console.log('\n         On Render: Dashboard > your Postgres > "External Database URL".');
    console.log('         The Internal URL only resolves from inside Render.\n');
    process.exit(1);
  }

  const url = process.env.DATABASE_URL;
  const host = (url.match(/@([^:/?]+)/) || [])[1] || 'unknown';
  ok(`DATABASE_URL points at ${host}`);
  if (/\.internal\b/.test(host)) {
    warn('that looks like a Render INTERNAL host — it will not resolve from a laptop');
  }

  if (process.env.BILLABLE_FIELD_ID) ok(`BILLABLE_FIELD_ID = ${process.env.BILLABLE_FIELD_ID}`);
  else warn('BILLABLE_FIELD_ID not set — expected, discover-fields.js resolves it');

  // --- connection ----------------------------------------------------------
  const pool = new Pool({
    connectionString: url,
    ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000
  });

  let client;
  try {
    client = await pool.connect();
    const { rows: [v] } = await client.query('SELECT version()');
    ok('connected — ' + v.version.split(',')[0]);
  } catch (err) {
    fail('cannot connect: ' + err.message);
    if (/self.signed|certificate/i.test(err.message)) {
      console.log('\n         TLS issue. For a local Postgres try: PGSSL=disable\n');
    }
    if (/timeout|ENOTFOUND|EHOSTUNREACH/i.test(err.message)) {
      console.log('\n         Check the host is reachable and IP access is allowed.\n');
    }
    process.exit(1);
  }

  const q = async (sql, params) => (await client.query(sql, params)).rows;
  const tableExists = async (t) =>
    (await q(`SELECT to_regclass($1) IS NOT NULL AS present`, [t]))[0].present;

  // --- required tables -----------------------------------------------------
  console.log('');
  for (const t of ['tickets', 'organizations']) {
    if (await tableExists(t)) ok(`table ${t} present`);
    else fail(`table ${t} MISSING`);
  }
  const optional = {
    agents: 'assignee_name refresh will be skipped',
    ticket_metrics: 'the SLA endpoints will return nothing',
    sync_status: 'the /sync-status endpoint will fail'
  };
  for (const [t, consequence] of Object.entries(optional)) {
    if (await tableExists(t)) ok(`table ${t} present`);
    else warn(`table ${t} absent — ${consequence}`);
  }

  if (failures) { await client.release(); await pool.end(); return report(); }

  // --- data readiness ------------------------------------------------------
  console.log('');
  const [{ total }] = await q('SELECT count(*)::int AS total FROM tickets');
  if (total > 0) ok(`${total.toLocaleString()} tickets synced`);
  else fail('tickets table is empty — has the sync run?');

  const [{ withcf }] = await q(
    `SELECT count(*)::int AS withcf FROM tickets
      WHERE custom_fields IS NOT NULL AND jsonb_typeof(custom_fields) = 'array'`
  );
  const pct = total ? ((withcf / total) * 100).toFixed(1) : '0';
  if (withcf === 0) fail('no tickets have array custom_fields — billing cannot be computed');
  else if (withcf / total < 0.5) warn(`only ${pct}% of tickets have custom_fields`);
  else ok(`${pct}% of tickets have custom_fields`);

  const [{ mind, maxd }] = await q(
    `SELECT min(created_at)::date AS mind, max(created_at)::date AS maxd FROM tickets`
  );
  if (mind) ok(`date range ${mind.toISOString().slice(0, 10)} .. ${maxd.toISOString().slice(0, 10)}`);

  // --- where are we in the sequence? --------------------------------------
  console.log('');
  const cols = (await q(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'tickets'
        AND column_name IN ('is_billable','billable_time_minutes','organization_name','assignee_name')`
  )).map(r => r.column_name);

  const migrated = cols.length === 4;
  const policies = await tableExists('billing_policies');

  let nextStep;
  if (!migrated) {
    ok('migration NOT yet applied — baseline can still be captured');
    nextStep = 'node bin/discover-fields.js --limit 50000';
  } else {
    warn(`migration already applied (${cols.join(', ')})`);
    if (!policies) warn('billing_policies missing — partial migration, re-run the .sql');
    const [{ pending }] = await q(
      `SELECT count(*)::int AS pending FROM tickets WHERE is_billable IS NULL`
    );
    if (pending > 0) {
      warn(`${pending.toLocaleString()} tickets still have is_billable = NULL`);
      nextStep = 'BILLABLE_FIELD_ID=<id> node bin/backfill-billing.js';
    } else {
      ok('backfill complete — every ticket has is_billable set');
      nextStep = 'node bin/compare.js baseline.json --from-db';
    }
  }

  // --- permissions ---------------------------------------------------------
  try {
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE _preflight_probe (x int)');
    await client.query('ROLLBACK');
    ok('database user can create objects');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    fail('insufficient privileges to run the migration: ' + err.message);
  }

  await client.release();
  await pool.end();
  report(nextStep);
}

function report(nextStep) {
  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.log(`NOT READY — ${failures} blocking issue${failures > 1 ? 's' : ''}, ${warnings} warning${warnings === 1 ? '' : 's'}`);
    console.log('='.repeat(64) + '\n');
    process.exit(1);
  }
  console.log(`READY${warnings ? ` — ${warnings} warning${warnings === 1 ? '' : 's'}, review above` : ''}`);
  console.log('='.repeat(64));
  if (nextStep) console.log(`\nNext:\n  ${nextStep}\n`);
  process.exit(0);
}

main().catch(err => {
  console.error('\nPreflight crashed:', err.message);
  process.exit(2);
});
