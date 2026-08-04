#!/usr/bin/env node
'use strict';
require('dotenv').config();

/**
 * Backfills tickets.custom_status_id for historical rows.
 *
 * Unlike the billing and derived-field backfills, this value cannot be
 * computed from stored data — custom_status_id is a top-level Zendesk ticket
 * property that the sync never captured, so it has to be re-fetched.
 *
 * Uses show_many (100 ticket ids per request) rather than replaying the
 * incremental stream, for three reasons:
 *   - it writes ONE column, so a re-sync cannot clobber billing or derived data
 *   - it is resumable: progress is durable in the column itself
 *   - it can run alongside the live sync without rewriting rows the sync owns
 *
 * At ~114k tickets and a 7s rate-limit delay this is roughly a 2 hour job.
 * It is safe to Ctrl-C and re-run; it picks up where it stopped.
 *
 * Usage:
 *   node bin/backfill-custom-status.js                    # everything missing
 *   node bin/backfill-custom-status.js --delay 5000       # override rate limit
 *   node bin/backfill-custom-status.js --limit 5000       # cap this run
 *   node bin/backfill-custom-status.js --from 2025-01-01  # date-bounded
 *   node bin/backfill-custom-status.js --dry-run
 */

const { Pool } = require('pg');
const axios = require('axios');

const flag = n => process.argv.includes(`--${n}`);
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN || 'intlxsolutions';
const DELAY = parseInt(arg('delay', '7000'), 10);   // matches SYNC_CONFIG
const BATCH = 100;                                   // show_many maximum
const LIMIT = arg('limit') ? parseInt(arg('limit'), 10) : null;
const FROM = arg('from', null);
const DRY = flag('dry-run');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
if (!process.env.ZENDESK_EMAIL || !process.env.ZENDESK_API_TOKEN) {
  console.error('ZENDESK_EMAIL / ZENDESK_API_TOKEN are not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
});

const AUTH = Buffer
  .from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`)
  .toString('base64');

const sleep = ms => new Promise(r => setTimeout(r, ms));

let stopping = false;
process.on('SIGINT', () => {
  console.log('\n\nStopping after the current batch — progress is saved, re-run to resume.');
  stopping = true;
});

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${Math.floor(sec % 60)}s`;
}

async function fetchBatch(ids, attempt = 1) {
  const url = `https://${SUBDOMAIN}.zendesk.com/api/v2/tickets/show_many.json?ids=${ids.join(',')}`;
  try {
    const { data } = await axios.get(url, {
      headers: { Authorization: `Basic ${AUTH}` },
      timeout: 30000
    });
    return data.tickets || [];
  } catch (err) {
    const status = err.response?.status;

    // Zendesk asks us to wait; honour it rather than hammering.
    if (status === 429) {
      const retryAfter = parseInt(err.response.headers['retry-after'] || '60', 10) * 1000;
      console.log(`\n  rate limited, waiting ${retryAfter / 1000}s...`);
      await sleep(retryAfter);
      return fetchBatch(ids, attempt);
    }
    if (status >= 500 && attempt <= 3) {
      console.log(`\n  Zendesk ${status}, retry ${attempt}/3 in 10s...`);
      await sleep(10000);
      return fetchBatch(ids, attempt + 1);
    }
    throw err;
  }
}

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('CUSTOM STATUS BACKFILL');
  console.log('='.repeat(60));
  console.log(`  batch size   ${BATCH} (show_many maximum)`);
  console.log(`  delay        ${DELAY}ms between requests`);
  if (FROM) console.log(`  from         ${FROM}`);
  if (LIMIT) console.log(`  limit        ${LIMIT.toLocaleString()} tickets this run`);
  if (DRY) console.log('  MODE         DRY RUN — no writes');

  const dateFilter = FROM ? 'AND created_at >= $1' : '';
  const dateParams = FROM ? [FROM] : [];

  const { rows: [{ pending }] } = await pool.query(
    `SELECT count(*)::int AS pending FROM tickets
      WHERE custom_status_id IS NULL ${dateFilter}`,
    dateParams
  );

  if (pending === 0) {
    console.log('\n  Nothing to backfill.\n');
    await pool.end();
    return;
  }

  const target = LIMIT ? Math.min(LIMIT, pending) : pending;
  const requests = Math.ceil(target / BATCH);
  const estSeconds = requests * (DELAY / 1000);

  console.log(`\n  ${pending.toLocaleString()} tickets missing custom_status_id`);
  console.log(`  processing ${target.toLocaleString()} in ${requests.toLocaleString()} requests`);
  console.log(`  estimated ${fmtDuration(estSeconds)}\n`);
  console.log('  Ctrl-C is safe — progress is saved after every batch.\n');

  const started = Date.now();
  let processed = 0, updated = 0, notFound = 0, batches = 0;

  while (processed < target && !stopping) {
    // Re-query each iteration rather than paging: rows drop out of the result
    // as they are filled, so there is no cursor to maintain and a re-run after
    // an interruption needs no state.
    const { rows } = await pool.query(
      `SELECT id FROM tickets
        WHERE custom_status_id IS NULL ${dateFilter}
        ORDER BY created_at DESC
        LIMIT $${FROM ? 2 : 1}`,
      [...dateParams, Math.min(BATCH, target - processed)]
    );
    if (rows.length === 0) break;

    // pg returns bigint columns as STRINGS; Zendesk returns ids as NUMBERS.
    // Both sides must be coerced or every lookup misses and every ticket looks
    // like it is missing from Zendesk.
    const ids = rows.map(r => Number(r.id));
    let tickets;
    try {
      tickets = await fetchBatch(ids);
    } catch (err) {
      console.error(`\n  Failed on batch starting ${ids[0]}: ${err.message}`);
      console.error('  Stopping. Re-run to resume from here.\n');
      break;
    }

    const found = new Map(tickets.map(t => [Number(t.id), t.custom_status_id ?? null]));

    // A whole batch missing is not a data condition, it is a bug — an id type
    // mismatch, a permissions change, or a malformed request. Marking 500 real
    // tickets as deleted is far worse than stopping, so refuse to continue.
    if (found.size === 0 && ids.length > 0) {
      console.error(`\n\n  ABORTING: Zendesk returned no tickets for a batch of ${ids.length}.`);
      console.error(`  Requested ids started with ${ids[0]}. Nothing was written for this batch.`);
      console.error('  This indicates a request problem, not missing tickets.\n');
      break;
    }

    // Tickets Zendesk no longer returns (deleted, or outside retention) would
    // otherwise be re-selected forever. Mark them 0 so the loop terminates;
    // 0 is not a valid Zendesk status id, so it is distinguishable from a real
    // value and from NULL.
    const updIds = [], updVals = [];
    for (const id of ids) {
      if (found.has(id)) {
        updIds.push(id);
        updVals.push(found.get(id));
        updated++;
      } else {
        updIds.push(id);
        updVals.push(0);
        notFound++;
      }
    }

    if (!DRY) {
      await pool.query(
        `UPDATE tickets AS t
            SET custom_status_id = v.csid
           FROM (SELECT unnest($1::bigint[]) AS id,
                        unnest($2::bigint[]) AS csid) AS v
          WHERE t.id = v.id`,
        [updIds, updVals]
      );
    }

    processed += ids.length;
    batches++;

    const elapsed = (Date.now() - started) / 1000;
    const rate = processed / elapsed;
    const remaining = target - processed;
    const eta = rate > 0 ? remaining / rate : 0;
    const pct = ((processed / target) * 100).toFixed(1);

    process.stdout.write(
      `\r  ${processed.toLocaleString()}/${target.toLocaleString()} (${pct}%)  ` +
      `updated ${updated.toLocaleString()}  ` +
      `missing ${notFound}  ` +
      `ETA ${fmtDuration(eta)}     `
    );

    if (processed < target && !stopping) await sleep(DELAY);
  }

  const elapsed = (Date.now() - started) / 1000;

  console.log('\n\n' + '='.repeat(60));
  console.log(stopping ? 'STOPPED — re-run to resume' : 'BACKFILL COMPLETE');
  console.log('='.repeat(60));
  console.log(`  processed        ${processed.toLocaleString()}`);
  console.log(`  updated          ${updated.toLocaleString()}`);
  console.log(`  not in Zendesk   ${notFound.toLocaleString()}${notFound ? '  (marked 0)' : ''}`);
  console.log(`  requests         ${batches.toLocaleString()}`);
  console.log(`  elapsed          ${fmtDuration(elapsed)}`);
  if (DRY) console.log('\n  DRY RUN — nothing was written.');

  if (!DRY) {
    const { rows: [after] } = await pool.query(
      `SELECT count(*) FILTER (WHERE custom_status_id IS NULL)::int AS still_null,
              count(*) FILTER (WHERE custom_status_id = 0)::int AS not_found,
              count(*)::int AS total FROM tickets`
    );
    console.log(`\n  remaining NULL   ${after.still_null.toLocaleString()} of ${after.total.toLocaleString()}`);
    if (after.not_found) {
      console.log(`  marked 0         ${after.not_found.toLocaleString()} (no longer in Zendesk)`);
    }
  }

  console.log('');
  await pool.end();
}

main().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
