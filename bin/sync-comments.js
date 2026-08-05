#!/usr/bin/env node
'use strict';
require('dotenv').config();

/**
 * Syncs comments for OPEN tickets, so update intervals can be measured.
 *
 * Why only open tickets: the public/private flag lives on
 * /tickets/{id}/comments.json, one call per ticket. At the 7s rate limit that
 * is ~22 minutes for the ~185 currently open, and about nine days for all
 * 115k. The incremental events feed covers every ticket but omits the flag
 * entirely, which is the one field this metric depends on.
 *
 * That bounds what the metric can say: it is a live view of which open tickets
 * have gone quiet, not a historical trend. A ticket that was neglected in March
 * and has since closed leaves no trace here.
 *
 * Two signals, both wanted:
 *   - last PUBLIC comment  — when the customer was last told anything
 *   - last AGENT comment   — whether anyone is working it at all, notes included
 *
 * Usage:
 *   node bin/sync-comments.js              # all open tickets
 *   node bin/sync-comments.js --limit 20   # cap this run
 *   node bin/sync-comments.js --delay 3000 # override the pause between calls
 */

const { Pool } = require('pg');
const axios = require('axios');

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 ? process.argv[i + 1] : d;
};

const SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN || 'intlxsolutions';
const DELAY = parseInt(arg('delay', '7000'), 10);
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
  console.log('\n\nStopping after the current ticket — progress is saved.');
  stopping = true;
});

async function fetchComments(ticketId, attempt = 1) {
  try {
    const { data } = await axios.get(
      `https://${SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}/comments.json`,
      { headers: { Authorization: `Basic ${AUTH}` }, timeout: 30000 }
    );
    return data.comments || [];
  } catch (err) {
    const status = err.response?.status;
    if (status === 429) {
      const wait = parseInt(err.response.headers['retry-after'] || '60', 10) * 1000;
      console.log(`\n  rate limited, waiting ${wait / 1000}s`);
      await sleep(wait);
      return fetchComments(ticketId, attempt);
    }
    // A deleted or restricted ticket should not stop the run.
    if (status === 404) return null;
    if (status >= 500 && attempt <= 3) {
      await sleep(10000);
      return fetchComments(ticketId, attempt + 1);
    }
    throw err;
  }
}

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('COMMENT SYNC — open tickets');
  console.log('='.repeat(60));

  const { rows: open } = await pool.query(`
    SELECT t.id
      FROM tickets t
     WHERE t.status NOT IN ('solved', 'closed', 'deleted')
     ORDER BY t.updated_at DESC
     ${LIMIT ? `LIMIT ${LIMIT}` : ''}
  `);

  const mins = Math.ceil((open.length * DELAY) / 60000);
  console.log(`  ${open.length} open tickets · about ${mins} minute${mins === 1 ? '' : 's'}\n`);

  // Loaded once: the roster does not change mid-run, and querying it per
  // ticket would be a needless round trip inside the loop.
  const agentIds = new Set(
    (await pool.query('SELECT id FROM agents')).rows.map((r) => String(r.id))
  );

  let done = 0, withPublic = 0, missing = 0;

  for (const { id } of open) {
    if (stopping) break;

    let comments;
    try {
      comments = await fetchComments(id);
    } catch (err) {
      console.error(`\n  ticket ${id}: ${err.message}`);
      break;
    }

    if (comments === null) { missing++; done++; continue; }

    // Only agent-authored comments count. A customer replying is not the team
    // keeping them informed, and counting it would mask silence on our side.
    const agentComments = comments.filter((c) => agentIds.has(String(c.author_id)));
    const publicAgent = agentComments.filter((c) => c.public === true);

    const lastPublic = publicAgent.length
      ? publicAgent[publicAgent.length - 1].created_at : null;
    const lastAgent = agentComments.length
      ? agentComments[agentComments.length - 1].created_at : null;

    if (lastPublic) withPublic++;

    await pool.query(`
      INSERT INTO ticket_comment_summary
        (ticket_id, comment_count, agent_comment_count, public_agent_comment_count,
         last_public_agent_at, last_agent_at, synced_at)
      VALUES ($1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (ticket_id) DO UPDATE SET
        comment_count = EXCLUDED.comment_count,
        agent_comment_count = EXCLUDED.agent_comment_count,
        public_agent_comment_count = EXCLUDED.public_agent_comment_count,
        last_public_agent_at = EXCLUDED.last_public_agent_at,
        last_agent_at = EXCLUDED.last_agent_at,
        synced_at = now()
    `, [id, comments.length, agentComments.length, publicAgent.length, lastPublic, lastAgent]);

    done++;
    process.stdout.write(
      `\r  ${done}/${open.length}  with public update: ${withPublic}  missing: ${missing}   `
    );

    if (done < open.length && !stopping) await sleep(DELAY);
  }

  console.log('\n\n' + '='.repeat(60));
  console.log(stopping ? 'STOPPED — re-run to continue' : 'COMPLETE');
  console.log('='.repeat(60));
  console.log(`  synced ${done}, with a public agent update ${withPublic}, missing ${missing}\n`);

  await pool.end();
}

main().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
