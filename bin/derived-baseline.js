#!/usr/bin/env node
'use strict';
require('dotenv').config();

/**
 * Stage 3a baseline — the derived-field equivalent of bin/baseline.js.
 *
 * Runs lib/legacy-derived.js (extracted verbatim from iframe.html) over real
 * synced tickets, freezes the per-ticket result, and reports the distribution
 * of each field so the column types and indexes can be chosen from evidence.
 *
 * Usage:
 *   node bin/derived-baseline.js [--from 2024-01-01] [--to 2026-12-31]
 *                                [--out derived-baseline.json]
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const legacy = require(path.join(__dirname, '..', 'lib', 'legacy-derived'));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const FROM = arg('from', '2000-01-01');
const TO   = arg('to', '2100-01-01');
const OUT  = arg('out', path.join(process.cwd(), 'derived-baseline.json'));

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
});

function parseJson(v, fallback) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
  return v;
}

function tally(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key] === null || r[key] === undefined ? '(null)' : String(r[key]);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function printTally(label, entries, total, limit = 15) {
  console.log(`\n  ${label}`);
  console.log('  ' + '-'.repeat(56));
  for (const [val, n] of entries.slice(0, limit)) {
    const pct = ((n / total) * 100).toFixed(1);
    console.log('    ' + val.padEnd(28) + n.toLocaleString().padStart(9) + '  ' + (pct + '%').padStart(7));
  }
  if (entries.length > limit) console.log(`    ...and ${entries.length - limit} more distinct values`);
}

async function main() {
  console.log(`Date range : ${FROM} .. ${TO}\n`);

  // Org-level Visualize subscriptions, if the column exists. The browser reads
  // this map before falling back to ticket tags.
  const orgSubs = new Map();
  try {
    const { rows } = await pool.query(
      `SELECT id, visualize_tier FROM organizations WHERE visualize_tier IS NOT NULL`
    );
    for (const r of rows) orgSubs.set(String(r.id), r.visualize_tier);
    console.log(`Loaded ${orgSubs.size} org subscriptions.`);
  } catch {
    console.log('No organizations.visualize_tier column — tier will come from tags only.');
    console.log('  (If subscriptions live elsewhere, tier parity will not match the UI.)');
  }

  const { rows } = await pool.query(
    `SELECT id, priority, status, organization_id, tags, custom_fields, metric_set
       FROM tickets
      WHERE created_at >= $1 AND created_at < $2
      ORDER BY id`,
    [FROM, TO]
  );
  console.log(`\nEvaluating ${rows.length.toLocaleString()} tickets...`);

  const results = [];
  for (const row of rows) {
    const ticket = {
      id: row.id,
      priority: row.priority,
      status: row.status,
      tags: parseJson(row.tags, []),
      custom_fields: parseJson(row.custom_fields, []),
      metric_set: parseJson(row.metric_set, null)
    };
    const sub = orgSubs.get(String(row.organization_id)) || null;
    results.push({
      id: row.id,
      status: row.status,
      organization_id: row.organization_id,
      ...legacy.computeDerivedFields(ticket, sub)
    });
  }

  const n = results.length;

  console.log('\n' + '='.repeat(64));
  console.log('DERIVED FIELD BASELINE');
  console.log('='.repeat(64));

  printTally('request_type_derived', tally(results, 'request_type_derived'), n);
  printTally('sla_status', tally(results, 'sla_status'), n);
  printTally('visualize_tier', tally(results, 'visualize_tier'), n);

  const alarms = {
    alarmtraq: results.filter(r => r.has_alarmtraq).length,
    virsae: results.filter(r => r.has_virsae).length,
    checkmk: results.filter(r => r.has_checkmk).length,
    any: results.filter(r => r.has_alarmtraq || r.has_virsae || r.has_checkmk).length
  };
  console.log('\n  alarm flags');
  console.log('  ' + '-'.repeat(56));
  for (const [k, v] of Object.entries(alarms)) {
    console.log('    ' + k.padEnd(28) + v.toLocaleString().padStart(9) + '  ' + ((v / n * 100).toFixed(1) + '%').padStart(7));
  }

  const withReply = results.filter(r => r.first_reply_minutes !== null);
  const withRes = results.filter(r => r.resolution_minutes !== null);
  console.log('\n  timing coverage');
  console.log('  ' + '-'.repeat(56));
  console.log('    first_reply_minutes'.padEnd(30) + withReply.length.toLocaleString().padStart(9) +
              '  ' + ((withReply.length / n * 100).toFixed(1) + '%').padStart(7));
  console.log('    resolution_minutes'.padEnd(30) + withRes.length.toLocaleString().padStart(9) +
              '  ' + ((withRes.length / n * 100).toFixed(1) + '%').padStart(7));

  // SLA compliance as the UI computes it: resolved tickets only.
  const resolved = results.filter(r => ['solved', 'closed'].includes(r.status));
  const met = resolved.filter(r => r.sla_status === 'Met').length;
  const missed = resolved.filter(r => r.sla_status === 'Missed').length;
  const rate = resolved.length ? ((met / resolved.length) * 100).toFixed(1) : 'n/a';
  console.log('\n  SLA compliance (solved/closed only, as the UI card computes it)');
  console.log('  ' + '-'.repeat(56));
  console.log(`    resolved tickets            ${resolved.length.toLocaleString().padStart(9)}`);
  console.log(`    met                         ${met.toLocaleString().padStart(9)}`);
  console.log(`    missed                      ${missed.toLocaleString().padStart(9)}`);
  console.log(`    compliance                  ${(rate + '%').padStart(9)}`);

  fs.writeFileSync(OUT, JSON.stringify({
    generated_at: new Date().toISOString(),
    params: { from: FROM, to: TO },
    totals: { tickets: n, ...alarms, resolved: resolved.length, sla_met: met, sla_missed: missed },
    tickets: results
  }, null, 2));

  console.log(`\nWritten to ${OUT}`);
  console.log('\nThe distributions above determine the column types and which');
  console.log('fields are worth indexing. Nothing has been written to tickets.\n');

  await pool.end();
}

main().catch(err => { console.error('\nFailed:', err.message); process.exit(1); });
