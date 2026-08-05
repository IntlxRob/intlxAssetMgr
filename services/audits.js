'use strict';

/**
 * Syncs public agent comments from the account-wide audit stream.
 *
 * This replaces the per-ticket comment sync. /api/v2/ticket_audits.json is a
 * single cursor-paged stream covering EVERY ticket, and unlike
 * incremental/ticket_events it carries the `public` flag — which is the one
 * field the update metric depends on.
 *
 * The per-ticket approach cost one API call per open ticket (~22 minutes for
 * 185) and could only ever see open work. This walks forward from wherever it
 * last stopped, covers closed tickets too, and the nightly delta is a handful
 * of pages.
 *
 * Direction matters. `after_cursor` moves toward newer records and is what a
 * routine sync follows. `before_cursor` moves toward older ones and is only
 * used by a deliberate backfill — five pages of 100 audits covered under five
 * hours of activity, so a year of history is roughly 9,000 pages.
 */

const axios = require('axios');

const SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN || 'intlxsolutions';
const PAGE_DELAY_MS = parseInt(process.env.AUDIT_SYNC_DELAY_MS || '1000', 10);
const MAX_PAGES = parseInt(process.env.AUDIT_SYNC_MAX_PAGES || '500', 10);

function authHeader() {
  const token = Buffer
    .from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`)
    .toString('base64');
  return { Authorization: `Basic ${token}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(url, attempt = 1) {
  try {
    const { data } = await axios.get(url, { headers: authHeader(), timeout: 30000 });
    return data;
  } catch (err) {
    const status = err.response?.status;
    if (status === 429) {
      const wait = parseInt(err.response.headers['retry-after'] || '60', 10) * 1000;
      console.log(`   rate limited, waiting ${wait / 1000}s`);
      await sleep(wait);
      return fetchPage(url, attempt);
    }
    if (status >= 500 && attempt <= 3) {
      await sleep(10000);
      return fetchPage(url, attempt + 1);
    }
    throw err;
  }
}

/**
 * Walks the audit stream and records public agent comments.
 *
 * @param {'forward'|'backward'} direction  forward for routine syncs,
 *        backward only for a deliberate history backfill.
 */
async function syncAudits(pool, { direction = 'forward', maxPages = MAX_PAGES } = {}) {
  const label = direction === 'forward' ? 'forward' : 'backfill';
  console.log(`📝 Starting audit sync (${label})...`);

  // Agent ids drive the filter: a customer replying is not the team keeping
  // them informed, and counting it would mask silence on our side.
  const agentIds = new Set(
    (await pool.query('SELECT id FROM agents')).rows.map((r) => String(r.id))
  );

  const cursorKey = direction === 'forward' ? 'audit_forward' : 'audit_backward';
  const { rows: [saved] } = await pool.query(
    'SELECT cursor FROM sync_cursors WHERE name = $1', [cursorKey]
  );

  const base = `https://${SUBDOMAIN}.zendesk.com/api/v2/ticket_audits.json?limit=100`;
  let url = saved?.cursor
    ? `${base}&cursor=${encodeURIComponent(saved.cursor)}`
    : base;

  let pages = 0, comments = 0, tickets = new Set(), newest = null, oldest = null;
  let cursor = saved?.cursor ?? null;

  while (pages < maxPages) {
    let data;
    try {
      data = await fetchPage(url);
    } catch (err) {
      console.error(`   Audit fetch failed on page ${pages + 1}: ${err.message}`);
      break;
    }

    const audits = data.audits || [];
    if (audits.length === 0) break;
    pages++;

    for (const audit of audits) {
      if (!newest || audit.created_at > newest) newest = audit.created_at;
      if (!oldest || audit.created_at < oldest) oldest = audit.created_at;

      for (const ev of (audit.events || [])) {
        if (ev.type !== 'Comment') continue;
        if (!agentIds.has(String(ev.author_id))) continue;

        comments++;
        tickets.add(audit.ticket_id);

        // One row per comment rather than a per-ticket summary: a trend needs
        // to know when each update happened, not just the most recent.
        await pool.query(`
          INSERT INTO ticket_public_comments
            (audit_id, ticket_id, author_id, is_public, created_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (audit_id) DO NOTHING
        `, [audit.id, audit.ticket_id, ev.author_id, ev.public === true, audit.created_at]);
      }
    }

    const nextCursor = direction === 'forward' ? data.after_cursor : data.before_cursor;
    const nextUrl = direction === 'forward' ? data.after_url : data.before_url;

    // A forward walk that reaches the end returns the same cursor repeatedly;
    // stopping on no-change avoids spinning against the rate limit.
    if (!nextUrl || nextCursor === cursor) break;

    cursor = nextCursor;
    url = nextUrl;
    await sleep(PAGE_DELAY_MS);
  }

  if (cursor) {
    await pool.query(`
      INSERT INTO sync_cursors (name, cursor, updated_at)
      VALUES ($1, $2, now())
      ON CONFLICT (name) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()
    `, [cursorKey, cursor]);
  }

  console.log(
    `✅ Audit sync (${label}): ${pages} pages, ${comments} agent comments across ${tickets.size} tickets`
  );
  if (oldest) console.log(`   range ${oldest} .. ${newest}`);

  return { pages, comments, tickets: tickets.size, oldest, newest };
}

module.exports = { syncAudits };
