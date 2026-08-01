#!/usr/bin/env node
'use strict';

/**
 * Step 1 of the harness.
 *
 * The legacy app resolves the billable field at runtime by fuzzy-matching
 * ticket field titles against 'billable' | 'bill' | 'chargeable' | 'invoiceable'
 * and taking the FIRST match Zendesk happens to return. That is
 * non-deterministic and must not be reproduced server-side.
 *
 * This script instead resolves the field empirically, from the data that has
 * actually been synced: it profiles every custom field ID present on tickets
 * and reports value distributions, so a human can pin the correct ID with
 * evidence rather than a substring guess.
 *
 * Usage:  DATABASE_URL=... node bin/discover-fields.js [--limit 50000]
 */

const { Pool } = require('pg');
const { TIME_FIELD_ID } = require('../lib/legacy-billing');

const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg !== -1 ? parseInt(args[limitArg + 1], 10) : 50000;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
});

const BOOLEAN_ISH = new Set(['true', 'false', 'yes', 'no', '1', '0', 'billable', 'non-billable']);

function classify(value) {
  if (value === null || value === undefined || value === '') return 'empty';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') {
    if (BOOLEAN_ISH.has(value.toLowerCase())) return 'boolean-ish string';
    if (!isNaN(parseFloat(value))) return 'numeric string';
    return 'string';
  }
  return typeof value;
}

async function main() {
  console.log(`Profiling custom fields across up to ${LIMIT.toLocaleString()} tickets...\n`);

  const { rows } = await pool.query(
    `SELECT id, custom_fields FROM tickets
      WHERE custom_fields IS NOT NULL
      ORDER BY updated_at DESC NULLS LAST
      LIMIT $1`,
    [LIMIT]
  );

  if (rows.length === 0) {
    console.error('No tickets with custom_fields found. Has the sync run?');
    process.exit(1);
  }

  const profile = new Map();

  for (const row of rows) {
    let fields = row.custom_fields;
    if (typeof fields === 'string') {
      try { fields = JSON.parse(fields); } catch { continue; }
    }
    if (!Array.isArray(fields)) continue;

    for (const field of fields) {
      if (!field || field.id === undefined) continue;
      if (!profile.has(field.id)) {
        profile.set(field.id, { id: field.id, present: 0, populated: 0, kinds: new Map(), samples: new Map() });
      }
      const p = profile.get(field.id);
      p.present++;

      const kind = classify(field.value);
      p.kinds.set(kind, (p.kinds.get(kind) || 0) + 1);
      if (kind !== 'empty') {
        p.populated++;
        const key = String(field.value).slice(0, 40);
        p.samples.set(key, (p.samples.get(key) || 0) + 1);
      }
    }
  }

  const all = [...profile.values()].sort((a, b) => b.populated - a.populated);

  // A billable field looks like: populated on a meaningful share of tickets,
  // and having a small number of distinct boolean-ish values.
  const candidates = all.filter(p => {
    if (p.populated === 0) return false;
    if (p.samples.size > 4) return false;
    const boolish = (p.kinds.get('boolean') || 0) + (p.kinds.get('boolean-ish string') || 0);
    return boolish / p.populated > 0.9;
  });

  console.log('='.repeat(72));
  console.log('BILLABLE FIELD CANDIDATES');
  console.log('='.repeat(72));
  if (candidates.length === 0) {
    console.log('None found. Widen the heuristic or inspect the full profile below.');
  }
  for (const c of candidates) {
    const pct = ((c.populated / rows.length) * 100).toFixed(1);
    console.log(`\n  field id: ${c.id}`);
    console.log(`  populated on ${c.populated.toLocaleString()} of ${rows.length.toLocaleString()} tickets (${pct}%)`);
    console.log('  value distribution:');
    for (const [val, n] of [...c.samples].sort((a, b) => b[1] - a[1])) {
      console.log(`      ${String(val).padEnd(22)} ${n.toLocaleString()}`);
    }
  }

  console.log('\n' + '='.repeat(72));
  console.log('TIME FIELD CHECK');
  console.log('='.repeat(72));
  const timeField = profile.get(TIME_FIELD_ID);
  if (!timeField) {
    console.log(`  WARNING: expected time field ${TIME_FIELD_ID} is absent from all sampled tickets.`);
  } else {
    const pct = ((timeField.populated / rows.length) * 100).toFixed(1);
    console.log(`  field id ${TIME_FIELD_ID} populated on ${timeField.populated.toLocaleString()} tickets (${pct}%)`);
    console.log(`  value kinds: ${[...timeField.kinds].map(([k, n]) => `${k}=${n}`).join(', ')}`);
  }

  console.log('\n' + '='.repeat(72));
  console.log('ALL FIELDS BY POPULATION (top 25)');
  console.log('='.repeat(72));
  console.log('  ' + 'field id'.padEnd(20) + 'populated'.padEnd(14) + 'distinct'.padEnd(11) + 'kinds');
  for (const p of all.slice(0, 25)) {
    const kinds = [...p.kinds.keys()].filter(k => k !== 'empty').join('/') || 'empty only';
    console.log(
      '  ' + String(p.id).padEnd(20) +
      String(p.populated).padEnd(14) +
      String(p.samples.size).padEnd(11) +
      kinds
    );
  }

  console.log('\nNext: pass the chosen id to the baseline script, e.g.');
  console.log(`  BILLABLE_FIELD_ID=<id> node bin/baseline.js\n`);

  await pool.end();
}

main().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
