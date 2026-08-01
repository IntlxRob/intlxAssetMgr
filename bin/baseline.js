#!/usr/bin/env node
'use strict';

/**
 * Step 2 of the harness.
 *
 * Runs the legacy billing logic (lib/legacy-billing.js, extracted verbatim from
 * iframe.html) over real synced tickets and freezes the result to disk.
 *
 * This file is the contract. Every later change — the sync-time port, the
 * schema migration, the endpoint swap — gets diffed against it with
 * bin/compare.js. Zero drift means ship.
 *
 * Usage:
 *   DATABASE_URL=... BILLABLE_FIELD_ID=123456 node bin/baseline.js \
 *     [--from 2024-01-01] [--to 2025-12-31] [--interval 30] [--out baseline.json]
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { evaluateTicket } = require('../lib/legacy-billing');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const BILLABLE_FIELD_ID = parseInt(process.env.BILLABLE_FIELD_ID, 10);
const FROM = arg('from', '2000-01-01');
const TO = arg('to', '2100-01-01');
const INTERVAL = parseInt(arg('interval', '30'), 10);
const OUT = arg('out', path.join(process.cwd(), 'baseline.json'));

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
if (!BILLABLE_FIELD_ID) {
  console.error('BILLABLE_FIELD_ID is not set. Run bin/discover-fields.js first to resolve it.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
});

async function main() {
  console.log(`Billable field : ${BILLABLE_FIELD_ID}`);
  console.log(`Date range     : ${FROM} .. ${TO}`);
  console.log(`Rounding       : ceil to ${INTERVAL} min\n`);

  const { rows } = await pool.query(
    `SELECT id, status, organization_id, custom_fields, created_at
       FROM tickets
      WHERE created_at >= $1 AND created_at < $2
      ORDER BY id`,
    [FROM, TO]
  );

  console.log(`Evaluating ${rows.length.toLocaleString()} tickets...`);

  const results = [];
  for (const row of rows) {
    let fields = row.custom_fields;
    if (typeof fields === 'string') {
      try { fields = JSON.parse(fields); } catch { fields = []; }
    }
    results.push(evaluateTicket(
      { id: row.id, status: row.status, organization_id: row.organization_id, custom_fields: fields || [] },
      { billableFieldId: BILLABLE_FIELD_ID, roundingInterval: INTERVAL }
    ));
  }

  const billable = results.filter(r => r.billable);
  const totals = {
    tickets: results.length,
    billable_tickets: billable.length,
    actual_minutes: results.reduce((s, r) => s + r.actual_minutes, 0),
    billable_actual_minutes: billable.reduce((s, r) => s + r.actual_minutes, 0),
    billed_minutes: results.reduce((s, r) => s + r.billed_minutes, 0),
    tickets_with_time: results.filter(r => r.actual_minutes > 0).length,
    billable_without_time: billable.filter(r => r.actual_minutes === 0).length,
    nonbillable_tracked_minutes: results
      .filter(r => !r.billable)
      .reduce((s, r) => s + r.actual_minutes, 0)
  };

  const baseline = {
    generated_at: new Date().toISOString(),
    params: { billable_field_id: BILLABLE_FIELD_ID, from: FROM, to: TO, rounding_interval: INTERVAL },
    totals,
    tickets: results
  };

  fs.writeFileSync(OUT, JSON.stringify(baseline, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log('BASELINE SUMMARY');
  console.log('='.repeat(60));
  console.log(`  tickets evaluated       ${totals.tickets.toLocaleString()}`);
  console.log(`  with tracked time       ${totals.tickets_with_time.toLocaleString()}`);
  console.log(`  marked billable         ${totals.billable_tickets.toLocaleString()}`);
  console.log('');
  console.log(`  actual hours (all)      ${(totals.actual_minutes / 60).toFixed(1)}`);
  console.log(`  actual hours (billable) ${(totals.billable_actual_minutes / 60).toFixed(1)}`);
  console.log(`  billed hours            ${(totals.billed_minutes / 60).toFixed(1)}`);

  // Compare like with like: billed vs actual for BILLABLE tickets only.
  const uplift = totals.billable_actual_minutes > 0
    ? ((totals.billed_minutes / totals.billable_actual_minutes - 1) * 100)
    : null;
  console.log(`  rounding uplift         ${uplift === null ? 'n/a' : (uplift >= 0 ? '+' : '') + uplift.toFixed(1) + '%'}`);
  console.log('    (billed vs actual, billable tickets only)');

  const unbilled = totals.nonbillable_tracked_minutes / 60;
  if (unbilled > 0) {
    const share = totals.actual_minutes > 0
      ? ((totals.nonbillable_tracked_minutes / totals.actual_minutes) * 100).toFixed(1)
      : '0';
    console.log('');
    console.log(`  tracked but not billable ${unbilled.toFixed(1)} h (${share}% of all tracked time)`);
    console.log('    Expected under a managed-services contract. Worth confirming');
    console.log('    it is contract coverage rather than missed flags.');
  }

  if (totals.billable_without_time > 0) {
    console.log(`\n  NOTE: ${totals.billable_without_time.toLocaleString()} tickets are marked billable but have`);
    console.log('        zero tracked time. Under ceil() these bill nothing.');
  }

  console.log(`\nWritten to ${OUT}`);
  await pool.end();
}

main().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
