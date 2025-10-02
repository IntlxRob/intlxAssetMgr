// routes/metricsBackfill.js
const express = require('express');
const axios = require('axios');

const router = express.Router();

router.get('/ping', (_req, res) => res.status(200).send('admin-metrics-ok'));

// ---- Zendesk creds (reuse your existing env) ----
const SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const EMAIL     = process.env.ZENDESK_EMAIL;
const API_TOKEN = process.env.ZENDESK_API_TOKEN;
const ZD_BASE   = `https://${SUBDOMAIN}.zendesk.com`;
const ZD_AUTH   = 'Basic ' + Buffer.from(`${EMAIL}/token:${API_TOKEN}`).toString('base64');

// ---- Where to send copies (your existing endpoint) ----
const COPY_URL = process.env.METRICS_COPY_URL
  || 'https://intlxassetmgr-proxy.onrender.com/hooks/metrics/copy';

// ---- Your numeric field IDs (env overrides allowed) ----
const FRT_BUS = Number(process.env.ZENDESK_FRT_BUSINESS_FIELD_ID || 35345034828183);
const FRT_CAL = Number(process.env.ZENDESK_FRT_CALENDAR_FIELD_ID || 35345064770327);
const FULL_BUS = Number(process.env.ZENDESK_FULLRES_BUSINESS_FIELD_ID || 35345430687383);
const FULL_CAL = Number(process.env.ZENDESK_FULLRES_CALENDAR_FIELD_ID || 35345460512663);

// Optional simple guard for this admin route
const ADMIN_KEY = process.env.METRICS_BACKFILL_KEY; // set this to any long string (or leave undefined to disable)

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchTicketIdsByCreatedRange(start, end, afterCursor, extraQuery) {
  // created range is inclusive/exclusive: >= start and < end
  const q = `created>=${start} created<${end}${extraQuery ? ' ' + extraQuery : ''}`;
  let url = `${ZD_BASE}/api/v2/search/export?filter[type]=ticket&query=${encodeURIComponent(q)}`;
  if (afterCursor) url += `&page[after]=${encodeURIComponent(afterCursor)}`;

  const r = await axios.get(url, {
    headers: { Authorization: ZD_AUTH, Accept: 'application/json' },
    timeout: 15000,
    validateStatus: () => true
  });

  if (r.status !== 200) {
    throw new Error(`search/export ${r.status}: ${JSON.stringify(r.data)}`);
  }

  const ids = (r.data.results || []).map(t => t.id);
  const next = r.data?.links?.next || null;
  const after = r.data?.meta?.after_cursor || null;

  return { ids, next, after };
}

// gentle concurrency helper
function pLimit(n) {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= n || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then((v) => resolve(v), reject)
      .finally(() => {
        active--;
        next();       // start the next job
      });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

// POST /admin/metrics/backfill
// body:
// {
//   "start": "2025-01-01", "end": "2025-02-01",
//   "after": "<cursor from previous run>",      // optional
//   "limit": 200,                                // tickets to process this call (default 200)
//   "concurrency": 5,                            // parallel copy calls (default 5)
//   "dry_run": false,                            // if true, don't update—just list IDs
//   "copy_frt": true,                            // include First Reply Time
//   "copy_fullres": true,                        // include Full Resolution Time
//   "only_solved_for_fullres": true              // filter search to solved when copying full res
// }
router.post('/backfill', async (req, res) => {
  try {
    if (ADMIN_KEY && req.headers['x-admin-key'] !== ADMIN_KEY) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const {
      start, end,
      after = null,
      limit = 200,
      concurrency = 5,
      dry_run = false,
      copy_frt = true,
      copy_fullres = true,
      only_solved_for_fullres = true
    } = req.body || {};

    if (!start || !end) {
      return res.status(400).json({ error: 'start and end (YYYY-MM-DD) are required' });
    }
    if (!copy_frt && !copy_fullres) {
      return res.status(400).json({ error: 'at least one of copy_frt or copy_fullres must be true' });
    }

    // Add an extra query constraint if we're pulling Full Resolution Time and you want solved tickets only
    const extraQuery = copy_fullres && only_solved_for_fullres ? 'status:solved' : '';

    // 1) get a page of ticket IDs
    const page = await fetchTicketIdsByCreatedRange(start, end, after, extraQuery);
    const ids = page.ids.slice(0, Number(limit));

    if (dry_run) {
      return res.json({
        mode: 'dry_run',
        range: { start, end },
        count: ids.length,
        ids,
        next_cursor: ids.length < page.ids.length ? page.after : page.after, // same cursor semantics
        note: 'call again with dry_run=false to update'
      });
    }

    // 2) build target maps for this run
    const maps = [];
    if (copy_frt) {
      maps.push({
        payload: {
          require_public_comment: false, // historical — don’t gate on public comment
          map: {
            'reply_time_in_minutes.business': FRT_BUS,
            'reply_time_in_minutes.calendar': FRT_CAL
          },
          retry_attempts: 6,
          retry_delay_ms: 1000
        }
      });
    }
    if (copy_fullres) {
      maps.push({
        payload: {
          require_public_comment: false,
          map: {
            'full_resolution_time_in_minutes.business': FRT_BUS && FULL_BUS, // ensure numbers
            'full_resolution_time_in_minutes.calendar': FRT_CAL && FULL_CAL
          },
          retry_attempts: 6,
          retry_delay_ms: 1000
        }
      });
    }

    // 3) process with gentle concurrency
    const limitRun = pLimit(Number(concurrency));
    let success = 0, skipped = 0, errors = 0;
    const results = [];

    await Promise.all(ids.map(id => limitRun(async () => {
      try {
        let wroteAny = false;
        for (const m of maps) {
          const body = { ticket_id: id, ...m.payload };
          // clean up accidental falsey IDs if env mis-set
          if (body.map['full_resolution_time_in_minutes.business'] === false) delete body.map['full_resolution_time_in_minutes.business'];
          if (body.map['full_resolution_time_in_minutes.calendar'] === false) delete body.map['full_resolution_time_in_minutes.calendar'];

          const r = await axios.post(COPY_URL, body, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 20000,
            validateStatus: () => true
          });
          if (r.status === 200) {
            wroteAny = true;
          } else if (r.status === 202) {
            // metrics-not-ready or no-mapped-values
            // treat as skip (harmless; can rerun later)
            skipped++;
            results.push({ id, status: r.data?.status || '202' });
          } else {
            errors++;
            results.push({ id, status: 'error', code: r.status, body: r.data });
          }
        }
        if (wroteAny) { success++; results.push({ id, status: 'ok' }); }
      } catch (e) {
        errors++;
        results.push({ id, status: 'exception', message: e.message });
      }
    })));

    return res.json({
      range: { start, end },
      processed: ids.length,
      success, skipped, errors,
      next_cursor: page.after, // pass this back; call the same route again with "after"
      hint: 'call again with same body + {"after":"<next_cursor>"} to continue'
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

module.exports = router;
