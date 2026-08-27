#!/usr/bin/env node
'use strict';
require('dotenv').config();

/**
 * Backfills the Stage 3a derived columns, then verifies them against
 * derived-baseline.json.
 *
 * Batched, resumable, safe to re-run. Default scope is rows the backfill has
 * not reached; --all recomputes everything.
 *
 * Usage:
 *   node bin/backfill-derived.js [--batch 5000] [--all] [--dry-run]
 *   node bin/backfill-derived.js --verify        # compare DB against baseline
 */

const path = require('path');
const { Pool } = require('pg');
const derived = require(path.join(__dirname, '..', 'services', 'derived'));

const flag = n => process.argv.includes(`--${n}`);
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const BATCH = parseInt(arg('batch', '5000'), 10);
const ALL = flag('all');
const DRY = flag('dry-run');
const VERIFY = flag('verify');

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

async function verify() {
  const fs = require('fs');
  const baselinePath = arg('baseline', path.join(process.cwd(), 'derived-baseline.json'));
  if (!fs.existsSync(baselinePath)) {
    console.error(`Baseline not found at ${baselinePath}. Run bin/derived-baseline.js first.`);
    process.exit(1);
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const baseMap = new Map(baseline.tickets.map(t => [Number(t.id), t]));

  const { rows } = await pool.query(
    `SELECT id, request_type_derived, has_alarmtraq, has_virsae, has_checkmk,
            first_reply_minutes, resolution_minutes
       FROM tickets ORDER BY id`
  );

  const drift = { request_type: [], alarms: [], first_reply: [], resolution: [] };
  let compared = 0, newRows = 0;

  for (const r of rows) {
    const b = baseMap.get(Number(r.id));
    if (!b) { newRows++; continue; }
    compared++;

    if ((b.request_type_derived ?? null) !== (r.request_type_derived ?? null))
      drift.request_type.push({ id: r.id, base: b.request_type_derived, db: r.request_type_derived });
    if (b.has_alarmtraq !== r.has_alarmtraq || b.has_virsae !== r.has_virsae || b.has_checkmk !== r.has_checkmk)
      drift.alarms.push({ id: r.id });
    if ((b.first_reply_minutes ?? null) !== (r.first_reply_minutes ?? null))
      drift.first_reply.push({ id: r.id, base: b.first_reply_minutes, db: r.first_reply_minutes });
    if ((b.resolution_minutes ?? null) !== (r.resolution_minutes ?? null))
      drift.resolution.push({ id: r.id, base: b.resolution_minutes, db: r.resolution_minutes });
  }

  console.log('\n' + '='.repeat(60));
  console.log('DERIVED PARITY REPORT');
  console.log('='.repeat(60));
  console.log(`  baseline tickets      ${baseMap.size.toLocaleString()}`);
  console.log(`  compared              ${compared.toLocaleString()}`);
  console.log(`  new since baseline    ${newRows.toLocaleString()}  (expected, live sync)`);
  console.log('');
  console.log(`  request_type drift    ${drift.request_type.length.toLocaleString()}`);
  console.log(`  alarm flag drift      ${drift.alarms.length.toLocaleString()}`);
  console.log(`  first_reply drift     ${drift.first_reply.length.toLocaleString()}`);
  console.log(`  resolution drift      ${drift.resolution.length.toLocaleString()}`);

  for (const [label, list] of Object.entries(drift)) {
    if (!list.length) continue;
    console.log(`\n  --- ${label} (first 10) ---`);
    for (const d of list.slice(0, 10)) {
      console.log(`    #${d.id}  baseline=${JSON.stringify(d.base)}  db=${JSON.stringify(d.db)}`);
    }
  }

  const clean = Object.values(drift).every(l => l.length === 0);
  console.log('\n' + (clean ? 'PARITY CLEAN — the server-side port matches the browser.'
                            : 'DRIFT DETECTED — review before shipping.'));
  await pool.end();
  process.exit(clean ? 0 : 1);
}

async function backfill() {
  console.log(`Scope     : ${ALL ? 'all rows' : 'rows where derived_computed_at IS NULL'}`);
  console.log(`Mode      : ${DRY ? 'DRY RUN — no writes' : 'writing'}`);
  console.log(`Batch     : ${BATCH.toLocaleString()}\n`);

  const where = ALL ? '' : 'WHERE derived_computed_at IS NULL';
  const { rows: [{ count }] } = await pool.query(`SELECT count(*)::int AS count FROM tickets ${where}`);
  console.log(`${count.toLocaleString()} tickets to process.\n`);
  if (count === 0) { await pool.end(); return; }

  let processed = 0, changed = 0, lastId = 0;
  const typeCounts = new Map();

  while (true) {
    const { rows } = await pool.query(
      `SELECT id, tags, custom_fields, metric_set,
              request_type_derived, ast_type, has_alarmtraq, has_virsae, has_checkmk,
              first_reply_minutes, resolution_minutes
         FROM tickets
        WHERE id > $1 ${ALL ? '' : 'AND derived_computed_at IS NULL'}
        ORDER BY id LIMIT $2`,
      [lastId, BATCH]
    );
    if (rows.length === 0) break;

    const ids = [], types = [], ast = [], at = [], vs = [], ck = [], fr = [], rs = [];

    for (const row of rows) {
      const ticket = {
        tags: parseJson(row.tags, []),
        custom_fields: parseJson(row.custom_fields, []),
        metric_set: parseJson(row.metric_set, null)
      };
      const d = derived.computeDerivedFields(ticket);

      if (row.request_type_derived !== d.request_type_derived ||
          row.ast_type !== d.ast_type ||
          row.has_alarmtraq !== d.has_alarmtraq ||
          row.has_virsae !== d.has_virsae ||
          row.has_checkmk !== d.has_checkmk ||
          row.first_reply_minutes !== d.first_reply_minutes ||
          row.resolution_minutes !== d.resolution_minutes) changed++;

      const key = d.request_type_derived === null ? '(null)' : d.request_type_derived;
      typeCounts.set(key, (typeCounts.get(key) || 0) + 1);

      ids.push(row.id);
      types.push(d.request_type_derived);
      ast.push(d.ast_type);
      at.push(d.has_alarmtraq); vs.push(d.has_virsae); ck.push(d.has_checkmk);
      fr.push(d.first_reply_minutes); rs.push(d.resolution_minutes);
      lastId = row.id;
    }

    if (!DRY) {
      await pool.query(
        `UPDATE tickets AS t
            SET request_type_derived = v.rt,
                ast_type = v.ast,
                has_alarmtraq = v.at, has_virsae = v.vs, has_checkmk = v.ck,
                first_reply_minutes = v.fr, resolution_minutes = v.rs,
                derived_computed_at = now()
           FROM (SELECT unnest($1::bigint[])  AS id,
                        unnest($2::text[])    AS rt,
                        unnest($8::text[])    AS ast,
                        unnest($3::boolean[]) AS at,
                        unnest($4::boolean[]) AS vs,
                        unnest($5::boolean[]) AS ck,
                        unnest($6::int[])     AS fr,
                        unnest($7::int[])     AS rs) AS v
          WHERE t.id = v.id`,
        [ids, types, at, vs, ck, fr, rs, ast]
      );
    }

    processed += rows.length;
    process.stdout.write(`\r  ${processed.toLocaleString()} / ${count.toLocaleString()}`);
  }

  console.log('\n\n' + '='.repeat(56));
  console.log('BACKFILL COMPLETE');
  console.log('='.repeat(56));
  console.log(`  processed        ${processed.toLocaleString()}`);
  console.log(`  values changed   ${changed.toLocaleString()}`);
  console.log('\n  request type distribution (top 8):');
  for (const [k, v] of [...typeCounts].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`    ${k.padEnd(30)} ${v.toLocaleString().padStart(9)}`);
  }
  if (DRY) console.log('\n  DRY RUN — nothing was written.');
  console.log('\nNext: node bin/backfill-derived.js --verify\n');

  await pool.end();
}

(VERIFY ? verify() : backfill()).catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
