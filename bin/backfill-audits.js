#!/usr/bin/env node
'use strict';
require('dotenv').config();

/**
 * Backfills public comment history from per-ticket audits.
 *
 * The account-wide audit stream covered four months densely and older periods
 * only incidentally — its backward cursor does not appear to page in strict
 * chronological order. But the data is all there: ticket 40620 returned four
 * comments from March 2025 with the public flag intact.
 *
 * So this walks tickets rather than the stream. One call per ticket, but the
 * ticket API is far more generous than the incremental exports: 20 calls at
 * 200ms took 16 seconds with no throttling, against the 7s per call the
 * comment sync assumed. 14,568 tickets is roughly three hours.
 *
 * Resumable. Progress lives in ticket_public_comments itself — a ticket with
 * rows is skipped — so an interrupted run needs no cursor.
 *
 * Usage:
 *   node bin/backfill-audits.js --from 2025-08-01
 *   node bin/backfill-audits.js --from 2025-08-01 --limit 500
 *   node bin/backfill-audits.js --from 2024-01-01 --delay 150
 */

const { Pool } = require('pg');
const axios = require('axios');

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 ? process.argv[i + 1] : d;
};

const SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN || 'intlxsolutions';
const FROM = arg('from', '2025-08-01');
const DELAY = parseInt(arg('delay', '200'), 10);
const LIMIT = arg('limit') ? parseInt(arg('limit'), 10) : null;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
});

const AUTH = Buffer
  .from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`)
  .toString('base64');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stopping = false;
process.on('SIGINT', () => {
  console.log('\n\nStopping after the current ticket — progress is saved, re-run to resume.');
  stopping = true;
});

function fmt(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function fetchAudits(ticketId, attempt = 1) {
  try {
    const { data } = await axios.get(
      `https://${SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}/audits.json`,
      { headers: { Authorization: `Basic ${AUTH}` }, timeout: 30000 }
    );
    return data.audits || [];
  } catch (err) {
    const status = err.response?.status;
    if (status === 429) {
      const wait = parseInt(err.response.headers['retry-after'] || '60', 10) * 1000;
      console.log(`\n  rate limited, waiting ${wait / 1000}s`);
      await sleep(wait);
      return fetchAudits(ticketId, attempt);
    }
    // Deleted or restricted: record nothing and move on rather than aborting.
    if (status === 404 || status === 403) return null;
    if (status >= 500 && attempt <= 3) {
      await sleep(5000);
      return fetchAudits(ticketId, attempt + 1);
    }
    throw err;
  }
}

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('AUDIT BACKFILL — per ticket');
  console.log('='.repeat(60));
  console.log(`  from ${FROM} · ${DELAY}ms between calls`);
  if (LIMIT) console.log(`  limit ${LIMIT.toLocaleString()} this run`);

  const agentIds = new Set(
    (await pool.query('SELECT id FROM agents')).rows.map((r) => String(r.id))
  );

  // Only tickets that had a reply and have no rows yet. reply_count > 1 skips
  // the ones that can have no interval to measure.
  const { rows: todo } = await pool.query(`
    SELECT t.id
      FROM tickets t
     WHERE t.reply_count > 1
       AND t.created_at >= $1
       AND NOT EXISTS (
         SELECT 1 FROM ticket_public_comments c WHERE c.ticket_id = t.id
       )
     ORDER BY t.created_at DESC
     ${LIMIT ? `LIMIT ${LIMIT}` : ''}
  `, [FROM]);

  if (todo.length === 0) {
    console.log('\n  Nothing to backfill.\n');
    await pool.end();
    return;
  }

  const est = (todo.length * (DELAY + 600)) / 1000;
  console.log(`\n  ${todo.length.toLocaleString()} tickets · estimated ${fmt(est)}`);
  console.log('  Ctrl-C is safe — a ticket with rows is skipped on re-run.\n');

  const started = Date.now();
  let done = 0, comments = 0, missing = 0;

  for (const { id } of todo) {
    if (stopping) break;

    let audits;
    try {
      audits = await fetchAudits(id);
    } catch (err) {
      console.error(`\n  Failed on ticket ${id}: ${err.message}`);
      console.error('  Stopping. Re-run to resume.\n');
      break;
    }

    if (audits === null) { missing++; done++; continue; }

    // Batched into one statement per ticket rather than one per comment —
    // 14k tickets at four comments each is 56k round trips otherwise.
    const rows = [];
    for (const audit of audits) {
      for (const ev of (audit.events || [])) {
        if (ev.type !== 'Comment') continue;
        if (!agentIds.has(String(ev.author_id))) continue;
        rows.push([audit.id, audit.ticket_id, ev.author_id, ev.public === true, audit.created_at]);
      }
    }

    if (rows.length > 0) {
      const values = rows
        .map((_, i) => `($${i * 5 + 1},$${i * 5 + 2},$${i * 5 + 3},$${i * 5 + 4},$${i * 5 + 5})`)
        .join(',');
      await pool.query(
        `INSERT INTO ticket_public_comments
           (audit_id, ticket_id, author_id, is_public, created_at)
         VALUES ${values}
         ON CONFLICT (audit_id) DO NOTHING`,
        rows.flat()
      );
      comments += rows.length;
    }

    done++;

    const elapsed = (Date.now() - started) / 1000;
    const eta = (todo.length - done) / (done / elapsed);
    process.stdout.write(
      `\r  ${done.toLocaleString()}/${todo.length.toLocaleString()}  ` +
      `comments ${comments.toLocaleString()}  missing ${missing}  ETA ${fmt(eta)}     `
    );

    if (done < todo.length && !stopping) await sleep(DELAY);
  }

  console.log('\n\n' + '='.repeat(60));
  console.log(stopping ? 'STOPPED — re-run to resume' : 'COMPLETE');
  console.log('='.repeat(60));
  console.log(`  tickets ${done.toLocaleString()} · comments ${comments.toLocaleString()} · missing ${missing}`);
  console.log(`  elapsed ${fmt((Date.now() - started) / 1000)}\n`);

  const { rows: [cov] } = await pool.query(`
    SELECT min(created_at)::date AS oldest,
           count(DISTINCT ticket_id)::int AS tickets,
           count(*)::int AS comments
      FROM ticket_public_comments
  `);
  console.log(`  coverage now: ${cov.comments.toLocaleString()} comments across ` +
              `${cov.tickets.toLocaleString()} tickets, back to ${cov.oldest}\n`);

  await pool.end();
}

main().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
