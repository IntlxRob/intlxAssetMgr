// routes/metrics.js
const express = require('express');
const router = express.Router();

const {
  getTicketMetrics,
  updateTicketCustomFields
} = require('../services/zendesk');

// Reuse any existing secret var; fall back to METRICS_SHARED_SECRET
const SHARED =
  process.env.ZENDESK_WEBHOOK_SECRET ||
  process.env.FRT_SHARED_SECRET ||
  process.env.METRICS_SHARED_SECRET;

// Your FRT field IDs (env overrides allowed)
const DEFAULT_BUS = Number(process.env.ZENDESK_FRT_BUSINESS_FIELD_ID || 35345034828183); // Business
const DEFAULT_CAL = Number(process.env.ZENDESK_FRT_CALENDAR_FIELD_ID || 35345064770327); // Calendar

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const toBool = v => v === true || v === 'true' || v === 'True' || v === 'TRUE' || v === 1 || v === '1';
const getByPath = (o, p) => p.split('.').reduce((a, k) => (a && a[k] !== undefined ? a[k] : undefined), o);

// --- quick debug endpoints so the route never "hangs" ---
router.get('/ping', (_req, res) => res.status(200).send('pong'));
router.post('/echo', (req, res) => res.status(200).json({ ok: true, headers: req.headers, body: req.body }));

// POST /hooks/metrics/copy
router.post('/copy', async (req, res) => {
  try {
    // Shared-secret header check (keeps bots out)
    if (SHARED && req.headers['x-zd-shared-secret'] !== SHARED) {
      return res.status(401).json({ error: 'bad-shared-secret' });
    }

    const {
      ticket_id,
      is_public,
      require_public_comment = true,
      map = {
        'reply_time_in_minutes.business': DEFAULT_BUS,
        'reply_time_in_minutes.calendar': DEFAULT_CAL
      },
      add_tag = '',                    // empty string = no tag
      retry_attempts = 3,              // metrics can lag briefly
      retry_delay_ms = 800
    } = req.body || {};

    if (!ticket_id) {
      return res.status(400).json({ error: 'missing ticket_id' });
    }

    // Enforce public comment if requested (Zendesk placeholders send strings)
    const isPublicBool = toBool(is_public);
    if (require_public_comment && !isPublicBool) {
      return res.status(202).json({ status: 'ignored', reason: 'not-public' });
    }

    // 1) Fetch metrics with short retries
    let metric = null;
    for (let i = 0; i < Number(retry_attempts); i++) {
      try {
        const m = await getTicketMetrics(ticket_id); // should return ticket_metric or null
        if (m && Object.keys(map).some(p => getByPath(m, p) != null)) {
          metric = m;
          break;
        }
      } catch (e) {
        // swallow and retry; GET may 404 if bad ID or momentary lag
      }
      await sleep(Number(retry_delay_ms) * (i + 1));
    }
    if (!metric) {
      return res.status(202).json({ status: 'metrics-not-ready' });
    }

    // 2) Build the custom_fields array from the map (send numbers for numeric fields)
    const toNumber = (v) => (typeof v === 'number' ? v : Number(v));

    const custom_fields = [];
    for (const [metricPath, fieldId] of Object.entries(map)) {
  const v = getByPath(metric, metricPath);
  const num = toNumber(v);
  if (!Number.isNaN(num)) {
    custom_fields.push({ id: Number(fieldId), value: num }); // numeric value
  }
    }   

    if (!custom_fields.length) {
      return res.status(202).json({ status: 'no-mapped-values' });
    }

    // 3) Update the ticket (only adds a tag if add_tag is a non-empty string)
    await updateTicketCustomFields(ticket_id, custom_fields, add_tag || undefined);

    return res.status(200).json({ status: 'ok', ticket_id: Number(ticket_id), written: custom_fields });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

module.exports = router;
