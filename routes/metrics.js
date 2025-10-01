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
    // (keep your shared-secret check)

    const {
      ticket_id,
      is_public,
      require_public_comment = true,
      map = {
        'reply_time_in_minutes.business': process.env.ZENDESK_FRT_BUSINESS_FIELD_ID || 35337631924119,
        'reply_time_in_minutes.calendar': process.env.ZENDESK_FRT_CALENDAR_FIELD_ID || 35337645628695
      },
      add_tag = '',
      retry_attempts = 3,
      retry_delay_ms = 800
    } = req.body || {};

    // 👇 NEW: coerce to boolean
    const toBool = v =>
      v === true || v === 'true' || v === 'True' || v === 'TRUE' || v === 1 || v === '1';

    const isPublicBool = toBool(is_public);

    if (!ticket_id) return res.status(400).json({ error: 'missing ticket_id' });

    // Only act on public comments if required
    if (require_public_comment && !isPublicBool) {
      return res.status(202).json({ status: 'ignored', reason: 'not-public' });
    }

    // ...rest of your logic (fetch metrics with brief retries, build fields, update ticket)...
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

module.exports = router;
