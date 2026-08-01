#!/usr/bin/env node
'use strict';

/**
 * Answers "is Stage 1 actually working?" in one command.
 *
 * Read-only. Checks five things in order of how much they prove:
 *   1. schema         — migration objects exist
 *   2. backfill       — historical rows are populated
 *   3. names          — denormalised names are filled in
 *   4. live sync      — NEW tickets are being computed by the deployed code
 *   5. endpoints      — the previously-dead analytics queries return data
 *
 * Check 4 is the one that proves the deploy. Everything else can pass while
 * the deployed sync is still writing nulls.
 *
 * Usage:  DATABASE_URL=... node bin/verify-stage1.js
 */

const { Pool } = require('pg');

const EXPECT_BILLABLE_FIELD = process.env.BILLABLE_FIELD_ID
  ? parseInt(process.env.BILLABLE_FIELD_ID, 10) : null;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
});

let fails = 0, warns = 0;
const ok = m => console.log('  [ok]  ' + m);
const warn = m => { console.log('  [--]  ' + m); warns++; };
const fail = m => { console.log('  [XX]  ' + m); fails++; };

const q = async (sql, p) => (await pool.query(sql, p)).rows;

async function main() {
  console.log('\n' + '='.repeat(66));
  console.log('STAGE 1 VERIFICATION');
  console.log('='.repeat(66));

  // --- 1. schema ---------------------------------------------------------
  console.log('\n1. SCHEMA');
  const objs = await q(`
    SELECT
      (SELECT count(*) FROM information_schema.columns
        WHERE table_name='tickets' AND table_schema=current_schema()
          AND column_name IN ('is_billable','billable_time_minutes',
                              'organization_name','assignee_name',
                              'billing_field_id','billing_computed_at'))::int AS cols,
      (to_regclass('billing_policies') IS NOT NULL) AS policies,
      (to_regclass('tickets_billed') IS NOT NULL)   AS view`);
  const o = objs[0];
  o.cols === 6 ? ok('all 6 billing columns present') : fail(`only ${o.cols} of 6 billing columns`);
  o.policies ? ok('billing_policies table present') : fail('billing_policies MISSING');
  o.view ? ok('tickets_billed view present') : fail('tickets_billed view MISSING');

  if (fails) return finish();

  // --- 2. backfill -------------------------------------------------------
  console.log('\n2. BACKFILL');
  const [b] = await q(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE is_billable IS NULL)::int AS nulls,
           count(*) FILTER (WHERE is_billable)::int AS billable,
           count(*) FILTER (WHERE billable_time_minutes > 0)::int AS with_time,
           count(DISTINCT billing_field_id)::int AS field_ids,
           max(billing_field_id)::text AS field_id
      FROM tickets`);
  ok(`${b.total.toLocaleString()} tickets`);
  b.nulls === 0 ? ok('no rows left uncomputed')
                : fail(`${b.nulls.toLocaleString()} rows still NULL — run backfill --all`);
  b.billable > 0 ? ok(`${b.billable.toLocaleString()} billable, ${b.with_time.toLocaleString()} with tracked time`)
                 : fail('zero billable tickets — billing field is wrong or unset');
  if (b.field_ids > 1) warn(`${b.field_ids} different billing_field_id values — logic changed mid-flight`);
  else if (EXPECT_BILLABLE_FIELD && b.field_id && Number(b.field_id) !== EXPECT_BILLABLE_FIELD)
    fail(`stored field id ${b.field_id} != expected ${EXPECT_BILLABLE_FIELD}`);
  else if (b.field_id) ok(`computed with field ${b.field_id}`);

  // --- 3. names ----------------------------------------------------------
  console.log('\n3. DENORMALISED NAMES');
  const [n] = await q(`
    SELECT count(*) FILTER (WHERE organization_name IS NOT NULL)::int AS orgs,
           count(*) FILTER (WHERE organization_id IS NOT NULL)::int AS has_org_id,
           count(*) FILTER (WHERE assignee_name IS NOT NULL)::int AS agents,
           count(*) FILTER (WHERE assignee_id IS NOT NULL)::int AS has_agent_id
      FROM tickets`);
  if (n.orgs === 0) fail('organization_name is empty — run refreshDenormalisedNames');
  else ok(`organization_name on ${n.orgs.toLocaleString()} of ${n.has_org_id.toLocaleString()} tickets with an org`);
  if (n.agents === 0) warn(`assignee_name empty (${n.has_agent_id.toLocaleString()} tickets have an assignee) — agents table may be named differently`);
  else ok(`assignee_name on ${n.agents.toLocaleString()} of ${n.has_agent_id.toLocaleString()} assigned tickets`);

  // --- 4. live sync ------------------------------------------------------
  // The real test. If the deployed code is running, tickets touched since
  // deploy carry a billing_computed_at stamp from the sync, not the backfill.
  console.log('\n4. LIVE SYNC  (does the deployed code compute billing?)');
  const [s] = await q(`
    SELECT max(updated_at)                       AS newest_ticket,
           max(billing_computed_at)              AS newest_computed,
           count(*) FILTER (WHERE updated_at > now() - interval '2 hours')::int AS touched_2h,
           count(*) FILTER (WHERE updated_at > now() - interval '2 hours'
                              AND billing_computed_at > now() - interval '2 hours')::int AS computed_2h
      FROM tickets`);

  if (s.newest_ticket) ok(`newest ticket update: ${new Date(s.newest_ticket).toISOString()}`);
  if (s.newest_computed) ok(`newest billing compute: ${new Date(s.newest_computed).toISOString()}`);

  if (s.touched_2h === 0) {
    warn('no tickets synced in the last 2 hours — cannot confirm the deploy yet');
    console.log('         This is inconclusive, not a failure. Wait for ticket activity,');
    console.log('         or touch a ticket in Zendesk and re-run in ~5 minutes.');
  } else if (s.computed_2h === 0) {
    fail(`${s.touched_2h} tickets synced recently but NONE were computed`);
    console.log('         The deployed sync is not running the new code, or');
    console.log('         BILLABLE_FIELD_ID is unset in the Render environment.');
  } else {
    ok(`${s.computed_2h} of ${s.touched_2h} recently-synced tickets were computed`);
  }

  // --- 5. endpoints ------------------------------------------------------
  console.log('\n5. PREVIOUSLY-DEAD ENDPOINTS');
  const [sum] = await q(`
    SELECT count(DISTINCT t.id)::int AS billable_tickets,
           round((SUM(t.billable_time_minutes)/60.0)::numeric,1)::text AS hours,
           count(DISTINCT t.organization_id)::int AS orgs
      FROM tickets t WHERE t.is_billable = true`);
  Number(sum.billable_tickets) > 0
    ? ok(`/billing/summary -> ${sum.billable_tickets} tickets, ${sum.hours} h, ${sum.orgs} orgs`)
    : fail('/billing/summary returns nothing');

  const byOrg = await q(`
    SELECT t.organization_name AS name,
           count(t.id)::int AS tickets,
           round((SUM(t.billable_time_minutes)/60.0)::numeric,1)::text AS hours
      FROM tickets t WHERE t.is_billable = true AND t.organization_name IS NOT NULL
     GROUP BY t.organization_name ORDER BY SUM(t.billable_time_minutes) DESC LIMIT 3`);
  if (byOrg.length === 0) fail('/billing/by-organization returns nothing');
  else {
    ok('/billing/by-organization ->');
    for (const r of byOrg) console.log(`           ${r.hours.padStart(8)} h  ${r.tickets.toString().padStart(5)} tickets  ${r.name}`);
  }

  // billed vs actual, through the policy view
  const [v] = await q(`
    SELECT round((SUM(billable_time_minutes)/60.0)::numeric,1)::text AS actual,
           round((SUM(billed_minutes)/60.0)::numeric,1)::text AS billed
      FROM tickets_billed WHERE is_billable = true`);
  ok(`tickets_billed view -> ${v.actual} h actual, ${v.billed} h billed after rounding`);

  finish();
}

function finish() {
  console.log('\n' + '='.repeat(66));
  if (fails) console.log(`FAILED — ${fails} problem${fails > 1 ? 's' : ''}, ${warns} warning${warns === 1 ? '' : 's'}`);
  else if (warns) console.log(`PASSING — ${warns} warning${warns === 1 ? '' : 's'}, review above`);
  else console.log('ALL CHECKS PASSED — Stage 1 is live and computing.');
  console.log('='.repeat(66) + '\n');
  pool.end();
  process.exit(fails ? 1 : 0);
}

main().catch(err => { console.error('\nFailed:', err.message); process.exit(2); });
