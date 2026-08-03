#!/usr/bin/env node
require('dotenv').config();
'use strict';

/**
 * Follow-up to discover-fields.js, for when the boolean heuristic comes up
 * empty — which happens when the billable field is a dropdown or tagger rather
 * than a checkbox.
 *
 * For each field ID given, prints every distinct value and, crucially, how
 * strongly each value correlates with the ticket having TRACKED TIME. A real
 * billable field should light up here: tickets marked billable should be
 * overwhelmingly the ones with time on them.
 *
 * Usage:
 *   DATABASE_URL=... node bin/inspect-field.js 21523698949271 22563831352855
 *   DATABASE_URL=... node bin/inspect-field.js --auto      # scan all plausible fields
 */

const { Pool } = require('pg');
const TIME_FIELD_ID = 17213443224599;

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const AUTO = process.argv.includes('--auto');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
if (!AUTO && args.length === 0) {
  console.error('Usage: inspect-field.js <fieldId> [fieldId...]   |   --auto');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
});

// Does this ticket have real tracked time? Mirrors extractTicketTime.
function trackedMinutes(fields) {
  if (!Array.isArray(fields)) return 0;
  const f = fields.find(x => x && x.id === TIME_FIELD_ID);
  if (!f || f.value === null || f.value === undefined || f.value === '') return 0;
  let m = 0;
  if (typeof f.value === 'number') m = f.value / 60;
  else if (typeof f.value === 'string') {
    const p = parseFloat(f.value.trim());
    if (!isNaN(p)) m = p / 60;
  }
  return Math.max(0, Math.round(m));
}

async function main() {
  console.log('\nLoading tickets...');
  const { rows } = await pool.query(
    `SELECT id, custom_fields FROM tickets
      WHERE custom_fields IS NOT NULL
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 50000`
  );

  const parsed = rows.map(r => {
    let f = r.custom_fields;
    if (typeof f === 'string') { try { f = JSON.parse(f); } catch { f = []; } }
    return { id: r.id, fields: Array.isArray(f) ? f : [], minutes: trackedMinutes(f) };
  });

  const withTime = parsed.filter(t => t.minutes > 0);
  console.log(`${parsed.length.toLocaleString()} tickets, ${withTime.length.toLocaleString()} with tracked time (${((withTime.length / parsed.length) * 100).toFixed(1)}%)\n`);

  let targets = args.map(a => parseInt(a, 10));

  if (AUTO) {
    // Any field with between 2 and 40 distinct values is a plausible
    // dropdown/tagger. Checkboxes and free text are both excluded.
    const counts = new Map();
    for (const t of parsed) {
      for (const f of t.fields) {
        if (!f || f.id === undefined) continue;
        if (f.value === null || f.value === undefined || f.value === '') continue;
        if (!counts.has(f.id)) counts.set(f.id, new Set());
        counts.get(f.id).add(String(f.value).slice(0, 60));
      }
    }
    targets = [...counts.entries()]
      .filter(([, vals]) => vals.size >= 2 && vals.size <= 40)
      .map(([id]) => id);
    console.log(`--auto: scanning ${targets.length} fields with 2-40 distinct values\n`);
  }

  const scored = [];

  for (const fieldId of targets) {
    const byValue = new Map();
    for (const t of parsed) {
      const f = t.fields.find(x => x && x.id === fieldId);
      const key = (!f || f.value === null || f.value === undefined || f.value === '')
        ? '(empty)' : String(f.value).slice(0, 60);
      if (!byValue.has(key)) byValue.set(key, { n: 0, withTime: 0, minutes: 0 });
      const b = byValue.get(key);
      b.n++;
      if (t.minutes > 0) { b.withTime++; b.minutes += t.minutes; }
    }

    // Best single value as a "billable = this" hypothesis: how much of all
    // tracked time does it capture, and how pure is it?
    let best = null;
    for (const [val, b] of byValue) {
      if (val === '(empty)') continue;
      const recall = withTime.length ? b.withTime / withTime.length : 0;
      const precision = b.n ? b.withTime / b.n : 0;
      const f1 = (precision + recall) ? (2 * precision * recall) / (precision + recall) : 0;
      if (!best || f1 > best.f1) best = { val, f1, precision, recall, ...b };
    }

    scored.push({ fieldId, byValue, best });
  }

  scored.sort((a, b) => (b.best?.f1 || 0) - (a.best?.f1 || 0));

  for (const s of scored.slice(0, AUTO ? 8 : scored.length)) {
    console.log('='.repeat(72));
    console.log(`FIELD ${s.fieldId}`);
    console.log('='.repeat(72));
    console.log('  ' + 'value'.padEnd(28) + 'tickets'.padEnd(11) + 'w/ time'.padEnd(11) + '% w/ time'.padEnd(12) + 'hours');
    console.log('  ' + '-'.repeat(68));
    const sorted = [...s.byValue.entries()].sort((a, b) => b[1].withTime - a[1].withTime);
    for (const [val, b] of sorted.slice(0, 15)) {
      const pct = b.n ? ((b.withTime / b.n) * 100).toFixed(1) : '0.0';
      console.log(
        '  ' + val.padEnd(28) +
        b.n.toLocaleString().padEnd(11) +
        b.withTime.toLocaleString().padEnd(11) +
        (pct + '%').padEnd(12) +
        (b.minutes / 60).toFixed(1)
      );
    }
    if (s.best) {
      console.log(`\n  best hypothesis: billable = "${s.best.val}"`);
      console.log(`    captures ${(s.best.recall * 100).toFixed(1)}% of all tracked time tickets`);
      console.log(`    of those tickets, ${(s.best.precision * 100).toFixed(1)}% actually have time`);
      console.log(`    fit score ${s.best.f1.toFixed(3)}`);
    }
    console.log('');
  }

  console.log('A real billable field should have one value that captures most');
  console.log('tickets with tracked time, and few without.\n');

  await pool.end();
}

main().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
