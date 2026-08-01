#!/usr/bin/env node
'use strict';

/**
 * Answers the 30-vs-15 question with numbers instead of intuition.
 *
 * Reads a baseline produced by bin/baseline.js and re-bills every ticket under
 * each candidate increment, reporting the delta in aggregate, per organization,
 * and by ticket size — because the effect of changing the increment is
 * concentrated entirely in short tickets, and orgs with a short-ticket queue
 * absorb nearly all of it.
 *
 * Usage:
 *   node bin/model-rounding.js baseline.json [--rate 200] [--intervals 30,15,10,1]
 */

const fs = require('fs');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const baselinePath = process.argv[2];
if (!baselinePath) {
  console.error('Usage: model-rounding.js <baseline.json> [--rate 200] [--intervals 30,15,10,1]');
  process.exit(2);
}

const RATE = parseFloat(arg('rate', '200'));
const INTERVALS = arg('intervals', '30,15,10,1').split(',').map(n => parseInt(n, 10));

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const billable = baseline.tickets.filter(t => t.billable);

const money = n => '$' + Math.round(n).toLocaleString();

function billedMinutes(tickets, interval) {
  return tickets.reduce((s, t) => s + Math.ceil(t.actual_minutes / interval) * interval, 0);
}

console.log('='.repeat(70));
console.log('ROUNDING MODEL');
console.log('='.repeat(70));
console.log(`  billable tickets   ${billable.length.toLocaleString()}`);
console.log(`  actual hours       ${(billable.reduce((s, t) => s + t.actual_minutes, 0) / 60).toFixed(1)}`);
console.log(`  hourly rate        $${RATE}`);
console.log(`  current policy     ceil to ${baseline.params.rounding_interval} min\n`);

const current = billedMinutes(billable, baseline.params.rounding_interval);

console.log('  ' + 'interval'.padEnd(12) + 'billed hrs'.padEnd(14) + 'revenue'.padEnd(14) + 'vs current');
console.log('  ' + '-'.repeat(56));
for (const interval of INTERVALS) {
  const mins = billedMinutes(billable, interval);
  const delta = (mins - current) / 60 * RATE;
  const pct = current > 0 ? ((mins / current - 1) * 100).toFixed(1) : '0.0';
  const marker = interval === baseline.params.rounding_interval ? '  (current)' : '';
  console.log(
    '  ' + `${interval} min`.padEnd(12) +
    (mins / 60).toFixed(1).padEnd(14) +
    money(mins / 60 * RATE).padEnd(14) +
    `${delta >= 0 ? '+' : ''}${money(delta)} (${pct}%)${marker}`
  );
}

// Where the loss concentrates: by actual ticket duration.
console.log('\n' + '='.repeat(70));
console.log('WHERE THE CHANGE LANDS (30 -> 15)');
console.log('='.repeat(70));
const buckets = [
  ['0 min', t => t.actual_minutes === 0],
  ['1-15 min', t => t.actual_minutes > 0 && t.actual_minutes <= 15],
  ['16-30 min', t => t.actual_minutes > 15 && t.actual_minutes <= 30],
  ['31-60 min', t => t.actual_minutes > 30 && t.actual_minutes <= 60],
  ['60+ min', t => t.actual_minutes > 60]
];
console.log('  ' + 'bucket'.padEnd(12) + 'tickets'.padEnd(11) + 'at 30'.padEnd(11) + 'at 15'.padEnd(11) + 'delta');
console.log('  ' + '-'.repeat(52));
for (const [label, pred] of buckets) {
  const group = billable.filter(pred);
  if (!group.length) continue;
  const at30 = billedMinutes(group, 30) / 60;
  const at15 = billedMinutes(group, 15) / 60;
  console.log(
    '  ' + label.padEnd(12) +
    group.length.toLocaleString().padEnd(11) +
    at30.toFixed(1).padEnd(11) +
    at15.toFixed(1).padEnd(11) +
    `${(at15 - at30) >= 0 ? '+' : ''}${money((at15 - at30) * RATE)}`
  );
}

// Per-organization exposure — contracts are negotiated per org, so this is the
// table that actually matters when deciding whether to change terms.
console.log('\n' + '='.repeat(70));
console.log('PER-ORGANIZATION EXPOSURE (30 -> 15, top 15 by impact)');
console.log('='.repeat(70));
const byOrg = new Map();
for (const t of billable) {
  const key = t.organization_id ?? 'none';
  if (!byOrg.has(key)) byOrg.set(key, []);
  byOrg.get(key).push(t);
}
const orgRows = [...byOrg.entries()].map(([org, tickets]) => {
  const at30 = billedMinutes(tickets, 30) / 60;
  const at15 = billedMinutes(tickets, 15) / 60;
  return { org, tickets: tickets.length, at30, at15, delta: (at15 - at30) * RATE };
}).sort((a, b) => a.delta - b.delta);

console.log('  ' + 'org id'.padEnd(16) + 'tickets'.padEnd(11) + 'at 30'.padEnd(11) + 'at 15'.padEnd(11) + 'delta');
console.log('  ' + '-'.repeat(56));
for (const r of orgRows.slice(0, 15)) {
  console.log(
    '  ' + String(r.org).padEnd(16) +
    r.tickets.toLocaleString().padEnd(11) +
    r.at30.toFixed(1).padEnd(11) +
    r.at15.toFixed(1).padEnd(11) +
    `${r.delta >= 0 ? '+' : ''}${money(r.delta)}`
  );
}
console.log('\nOrg IDs only — join against organizations for names.\n');
