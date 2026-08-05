'use strict';

/**
 * Syncs comment activity for open tickets, so update intervals stay current.
 *
 * The public/private flag only exists on /tickets/{id}/comments.json — one
 * call per ticket — so this is scoped to open tickets. About 185 at present,
 * roughly 22 minutes at the shared rate limit. All 115k would take nine days.
 *
 * Runs overnight rather than hourly: it holds the Zendesk rate limit for its
 * whole duration, and a "gone quiet" list is a morning question, not a
 * minute-by-minute one.
 */

const axios = require('axios');

const SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN || 'intlxsolutions';
const DELAY_MS = parseInt(process.env.COMMENT_SYNC_DELAY_MS || '7000', 10);

function authHeader() {
  const token = Buffer
    .from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`)
    .toString('base64');
  return { Authorization: `Basic ${token}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchComments(ticketId, attempt = 1) {
  try {
    const { data } = await axios.get(
      `https://${SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}/comments.json`,
      { headers: authHeader(), timeout: 30000 }
    );
    return data.comments || [];
  } catch (err) {
    const status = err.response?.status;
    if (status === 429) {
      const wait = parseInt(err.response.headers['retry-after'] || '60', 10) * 1000;
      await sleep(wait);
      return fetchComments(ticketId, attempt);
    }
    // Deleted or restricted: skip rather than abort the run.
    if (status === 404 || status === 403) return null;
    if (status >= 500 && attempt <= 3) {
      await sleep(10000);
      return fetchComments(ticketId, attempt + 1);
    }
    throw err;
  }
}

async function syncOpenTicketComments(pool) {
  console.log('💬 Starting comment sync for open tickets...');

  // Open tickets, plus any RECENTLY CLOSED one we have never captured.
  //
  // A ticket opened and resolved between two nightly runs would otherwise
  // never be seen — and since rows are kept for the trend, a permanent hole
  // appears in exactly the fast-turnaround work the metric should reward.
  // Bounded to 7 days so the run length stays predictable.
  const { rows: open } = await pool.query(`
    SELECT t.id
      FROM tickets t
      LEFT JOIN ticket_comment_summary cs ON cs.ticket_id = t.id
     WHERE t.status NOT IN ('solved', 'closed', 'deleted')
        OR (cs.ticket_id IS NULL AND t.solved_at > now() - interval '7 days')
     ORDER BY t.updated_at DESC
  `);

  if (open.length === 0) {
    console.log('   Nothing to sync.');
    return { synced: 0 };
  }

  // Loaded once — the roster does not change mid-run, and querying it per
  // ticket would be a round trip inside the loop.
  const agentIds = new Set(
    (await pool.query('SELECT id FROM agents')).rows.map((r) => String(r.id))
  );

  console.log(`   ${open.length} tickets to sync, ~${Math.ceil((open.length * DELAY_MS) / 60000)} min`);

  let synced = 0, skipped = 0;

  for (const { id } of open) {
    let comments;
    try {
      comments = await fetchComments(id);
    } catch (err) {
      console.error(`   Comment sync failed on ticket ${id}: ${err.message}`);
      break;
    }

    if (comments === null) { skipped++; continue; }

    // Only agent-authored comments count. A customer replying is not the team
    // keeping them informed, and counting it would mask silence on our side.
    const agentComments = comments.filter((c) => agentIds.has(String(c.author_id)));
    const publicAgent = agentComments.filter((c) => c.public === true);

    try {
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
      `, [
        id,
        comments.length,
        agentComments.length,
        publicAgent.length,
        publicAgent.length ? publicAgent[publicAgent.length - 1].created_at : null,
        agentComments.length ? agentComments[agentComments.length - 1].created_at : null
      ]);
      synced++;
    } catch (err) {
      console.error(`   Upsert failed for ticket ${id}: ${err.message}`);
    }

    await sleep(DELAY_MS);
  }

  // Rows are KEPT after a ticket closes. The live view queries join against
  // open tickets and ignore them, but holding the final state is what makes a
  // trend possible later — "was update compliance better in Q1" cannot be
  // answered from data that was deleted.
  //
  // The row is a per-ticket summary, not per-comment, so growth is one row per
  // ticket ever opened rather than per comment. At current volume that is
  // roughly 40k rows a year.
  const { rows: [stats] } = await pool.query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE t.status NOT IN ('solved','closed','deleted'))::int AS still_open
      FROM ticket_comment_summary cs
      JOIN tickets t ON t.id = cs.ticket_id
  `);

  console.log(`✅ Comment sync complete: ${synced} synced, ${skipped} skipped`);
  console.log(`   ${stats.total} rows retained (${stats.still_open} open, rest kept for trend)`);
  return { synced, skipped, retained: stats.total };
}

module.exports = { syncOpenTicketComments };
