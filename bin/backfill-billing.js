#!/usr/bin/env node
require('dotenv').config();
'use strict';

/**
 * Populates is_billable / billable_time_minutes on rows that predate the sync
 * change. Batched, resumable, and safe to re-run.
 *
 * Usage:
 *   DATABASE_URL=... BILLABLE_FIELD_ID=123456 node bin/backfill-billing.js \
 *     [--batch 5000] [--all] [--dry-run]
 *
 *   --all       recompute every row, not just rows where is_billable IS NULL.
 *               Use after changing the billing rules.
 *   --dry-run   report what would change without writing.
 */

const { Pool } = require('pg');
const path = require('path');
const { computeBillable, computeBillableMinutes, BILLABLE_FIELD_ID } =
  require(path.join(__dirname, '..', 'services', 'billing'));

function flag(name) { return process.argv.includes(`--${name}`); }
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const BATCH = parseInt(arg('batch', '5000'), 10);
const ALL = flag('all');
const DRY = flag('dry-run');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
if (!BILLABLE_FIELD_ID) {
  console.error('BILLABLE_FIELD_ID is not set. Run bin/discover-fields.js first.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
});

async function main() {
  console.log(`Billable field : ${BILLABLE_FIELD_ID}`);
  console.log(`Scope          : ${ALL ? 'all rows' : 'rows where is_billable IS NULL'}`);
  console.log(`Mode           : ${DRY ? 'DRY RUN — no writes' : 'writing'}`);
  console.log(`Batch size     : ${BATCH.toLocaleString()}\n`);

  const where = ALL ? '' : 'WHERE is_billable IS NULL';
  const { rows: [{ count }] } = await pool.query(`SELECT count(*)::int AS count FROM tickets ${where}`);
  console.log(`${count.toLocaleString()} tickets to process.\n`);
  if (count === 0) { await pool.end(); return; }

  let processed = 0, billable = 0, withTime = 0, changed = 0;
  let lastId = 0;

  while (processed < count) {
    const { rows } = await pool.query(
      `SELECT id, custom_fields, is_billable, billable_time_minutes
         FROM tickets
        WHERE id > $1 ${ALL ? '' : 'AND is_billable IS NULL'}
        ORDER BY id
        LIMIT $2`,
      [lastId, BATCH]
    );
    if (rows.length === 0) break;

    const ids = [], flags = [], minutes = [];

    for (const row of rows) {
      let fields = row.custom_fields;
      if (typeof fields === 'string') {
        try { fields = JSON.parse(fields); } catch { fields = []; }
      }
      const ticket = { custom_fields: fields || [] };
      const isB = computeBillable(ticket);
      const mins = computeBillableMinutes(ticket);

      if (row.is_billable !== isB || row.billable_time_minutes !== mins) changed++;
      if (isB) billable++;
      if (mins > 0) withTime++;

      ids.push(row.id); flags.push(isB); minutes.push(mins);
      lastId = row.id;
    }

    if (!DRY) {
      await pool.query(
        `UPDATE tickets AS t
            SET is_billable = v.is_billable,
                billable_time_minutes = v.minutes,
                billing_field_id = $4,
                billing_computed_at = now()
           FROM (SELECT unnest($1::bigint[]) AS id,
                        unnest($2::boolean[]) AS is_billable,
                        unnest($3::int[])     AS minutes) AS v
          WHERE t.id = v.id`,
        [ids, flags, minutes, BILLABLE_FIELD_ID]
      );
    }

    processed += rows.length;
    process.stdout.write(`\r  ${processed.toLocaleString()} / ${count.toLocaleString()}`);
  }

  console.log('\n\n' + '='.repeat(56));
  console.log('BACKFILL COMPLETE');
  console.log('='.repeat(56));
  console.log(`  processed          ${processed.toLocaleString()}`);
  console.log(`  marked billable    ${billable.toLocaleString()}`);
  console.log(`  with tracked time  ${withTime.toLocaleString()}`);
  console.log(`  values changed     ${changed.toLocaleString()}`);
  if (DRY) console.log('\n  DRY RUN — nothing was written.');

  const zeroTime = billable > 0
    ? (await pool.query(
        `SELECT count(*)::int AS n FROM tickets WHERE is_billable = true AND COALESCE(billable_time_minutes,0) = 0`
      )).rows[0].n
    : 0;
  if (zeroTime > 0) {
    console.log(`\n  ${zeroTime.toLocaleString()} tickets are billable with zero tracked time.`);
    console.log('  These bill nothing under ceil(). Worth an audit before go-live.');
  }

  console.log('\nNext: node bin/compare.js baseline.json --from-db\n');
  await pool.end();
}

main().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
