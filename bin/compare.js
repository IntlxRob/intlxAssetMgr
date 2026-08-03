#!/usr/bin/env node
require('dotenv').config();
'use strict';

/**
 * Step 3 of the harness — the regression gate.
 *
 * Diffs a candidate result set against the frozen baseline and exits non-zero
 * on any drift, so it can sit in CI or a pre-deploy check.
 *
 * The candidate can be either another baseline.json, or (with --from-db) the
 * is_billable / billable_time_minutes columns as populated by the new
 * sync-time logic. The second mode is the one that proves the Stage 1 port.
 *
 * Usage:
 *   node bin/compare.js baseline.json candidate.json
 *   DATABASE_URL=... node bin/compare.js baseline.json --from-db [--interval 30]
 */

const fs = require('fs');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const baselinePath = process.argv[2];
const candidatePath = process.argv[3];
const INTERVAL = parseInt(arg('interval', '30'), 10);
const MAX_SHOWN = parseInt(arg('show', '25'), 10);

if (!baselinePath || !candidatePath) {
  console.error('Usage: compare.js <baseline.json> <candidate.json | --from-db>');
  process.exit(2);
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

async function loadCandidate() {
  if (candidatePath !== '--from-db') {
    return JSON.parse(fs.readFileSync(candidatePath, 'utf8')).tickets;
  }

  const { Pool } = require('pg');
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(2);
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
  });

  const { from, to } = baseline.params;
  const { rows } = await pool.query(
    `SELECT id, status, organization_id, is_billable, billable_time_minutes
       FROM tickets
      WHERE created_at >= $1 AND created_at < $2
      ORDER BY id`,
    [from, to]
  );
  await pool.end();

  return rows.map(r => {
    const actual = r.billable_time_minutes || 0;
    const rounded = Math.ceil(actual / INTERVAL) * INTERVAL;
    return {
      id: Number(r.id),
      status: r.status,
      organization_id: r.organization_id,
      billable: r.is_billable === true,
      actual_minutes: actual,
      rounded_minutes: rounded,
      billed_minutes: r.is_billable === true ? rounded : 0
    };
  });
}

function fmt(t) {
  return `#${t.id} billable=${t.billable} actual=${t.actual_minutes}m billed=${t.billed_minutes}m`;
}

async function main() {
  const candidate = await loadCandidate();

  const baseMap = new Map(baseline.tickets.map(t => [Number(t.id), t]));
  const candMap = new Map(candidate.map(t => [Number(t.id), t]));

  const missing = [];
  const added = [];
  const billableDrift = [];
  const timeDrift = [];

  for (const [id, b] of baseMap) {
    const c = candMap.get(id);
    if (!c) { missing.push(b); continue; }
    if (b.billable !== c.billable) billableDrift.push({ id, base: b, cand: c });
    else if (b.actual_minutes !== c.actual_minutes) timeDrift.push({ id, base: b, cand: c });
  }
  for (const [id, c] of candMap) if (!baseMap.has(id)) added.push(c);

  const baseBilled = baseline.tickets.reduce((s, t) => s + t.billed_minutes, 0);
  const candBilled = candidate.reduce((s, t) => s + t.billed_minutes, 0);

  console.log('='.repeat(64));
  console.log('PARITY REPORT');
  console.log('='.repeat(64));
  console.log(`  baseline tickets        ${baseMap.size.toLocaleString()}`);
  console.log(`  candidate tickets       ${candMap.size.toLocaleString()}`);
  console.log(`  missing from candidate  ${missing.length.toLocaleString()}`);
  console.log(`  new in candidate        ${added.length.toLocaleString()}`);
  console.log(`  billable flag drift     ${billableDrift.length.toLocaleString()}`);
  console.log(`  tracked time drift      ${timeDrift.length.toLocaleString()}`);
  console.log(`  billed hours (baseline) ${(baseBilled / 60).toFixed(1)}`);
  console.log(`  billed hours (candidate)${(candBilled / 60).toFixed(1)}`);

  const deltaHours = (candBilled - baseBilled) / 60;
  const pct = baseBilled > 0 ? ((candBilled / baseBilled - 1) * 100).toFixed(2) : 'n/a';
  console.log(`  delta                   ${deltaHours >= 0 ? '+' : ''}${deltaHours.toFixed(1)} h (${pct}%)`);

  if (billableDrift.length) {
    console.log('\n--- BILLABLE FLAG DRIFT ---');
    for (const d of billableDrift.slice(0, MAX_SHOWN)) {
      console.log(`  #${d.id}  baseline=${d.base.billable}  candidate=${d.cand.billable}  (${d.base.status})`);
    }
    if (billableDrift.length > MAX_SHOWN) console.log(`  ...and ${billableDrift.length - MAX_SHOWN} more`);
  }

  if (timeDrift.length) {
    console.log('\n--- TRACKED TIME DRIFT ---');
    for (const d of timeDrift.slice(0, MAX_SHOWN)) {
      console.log(`  #${d.id}  baseline=${d.base.actual_minutes}m  candidate=${d.cand.actual_minutes}m`);
    }
    if (timeDrift.length > MAX_SHOWN) console.log(`  ...and ${timeDrift.length - MAX_SHOWN} more`);
  }

  if (missing.length) {
    console.log('\n--- MISSING FROM CANDIDATE ---');
    for (const t of missing.slice(0, MAX_SHOWN)) console.log('  ' + fmt(t));
    if (missing.length > MAX_SHOWN) console.log(`  ...and ${missing.length - MAX_SHOWN} more`);
  }

  const clean = !billableDrift.length && !timeDrift.length && !missing.length;
  console.log('\n' + (clean ? 'PARITY CLEAN — safe to proceed.' : 'DRIFT DETECTED — review before shipping.'));
  process.exit(clean ? 0 : 1);
}

main().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(2);
});
