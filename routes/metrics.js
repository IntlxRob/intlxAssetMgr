// routes/metrics.js
const express = require('express');
const router = express.Router();

const {
  getTicketMetrics,
  updateTicketCustomFields
} = require('../services/zendesk');

// Use an existing secret if you have one; otherwise add METRICS_SHARED_SECRET
const SHARED =
  process.env.METRICS_SHARED_SECRET ||
  process.env.ZENDESK_WEBHOOK_SECRET ||
  process.env.FRT_SHARED_SECRET;

const FIELD_BUS = 35337631924119; // First Reply Time (Business)
const FIELD_CAL = 35337645628695; // First Reply Time (Calendar)

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// POST /hooks/metrics/copy
router.post('/copy', async (req, res) => {
  try {
    if (SHARED && req.headers['x-zd-shared-secret'] !== SHARED) {
      return res.status(401).json({ error: 'bad-shared-secret' });
    }

    const {
      ticket_id,
      is_public,
      require_public_comment = true,
      // default map = FRT business + calendar using your field IDs
      map = {
        'reply_time_in_minutes.business': FIELD_BUS,
        'reply_time_in_minutes.calendar': FIELD_CAL
      },
      add_tag = 'frt_copied',
      retry_attempts = 3,
      retry_delay_ms = 800
    } = req.body || {};

    if (!ticket_id) return res.status(400).json({ error: 'missing ticket_id' });
    if (require_public_comment && is_public !== true) {
      return res.status(202).json({ status: 'ignored' });
    }

    // fetch metrics (with brief retries)
    let metric = null;
    for (let i = 0; i < retry_attempts; i++) {
      const m = await getTicketMetrics(ticket_id);
      if (m && (
        m.reply_time_in_minutes?.business != null ||
        m.reply_time_in_minutes?.calendar != null
      )) { metric = m; break; }
      await sleep(retry_delay_ms * (i + 1));
    }
    if (!metric) return res.status(202).json({ status: 'metrics-not-ready' });

    // build fields array from the map
    const getByPath = (o, p) => p.split('.').reduce((a, k) => (a && a[k] !== undefined ? a[k] : undefined), o);
    const fields = Object.entries(map).reduce((arr, [path, id]) => {
      const val = getByPath(metric, path);
      if (val != null) arr.push({ id: Number(id), value: String(val) });
      return arr;
    }, []);
    if (!fields.length) return res.status(202).json({ status: 'no-mapped-values' });

    await updateTicketCustomFields(ticket_id, fields, add_tag);
    res.json({ status: 'ok', ticket_id, written: fields });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

module.exports = router;
