// middleware/verifyZendeskToken.js
//
// INBOUND verification for Zendesk webhooks.
//
// This compares a value Zendesk SENDS US against a secret we hold. It is the
// opposite direction from services/zendeskAuth.js, which builds credentials
// for OUTBOUND calls. Same subject, opposite direction - do not merge them.
//
// TRANSITIONAL: accepts either ZENDESK_WEBHOOK_SECRET (new) or
// ZENDESK_API_TOKEN (legacy), so deploying this cannot break webhooks still
// configured with the old value. Once the Zendesk webhook config is updated
// and the warning below stops appearing, delete the legacy branch.

const crypto = require('crypto');

const WEBHOOK_SECRET = process.env.ZENDESK_WEBHOOK_SECRET;
const LEGACY_TOKEN = process.env.ZENDESK_API_TOKEN; // delete after cutover

function safeEqual(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string' || !expected) {
    return false;
  }
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = function verifyZendeskToken(req, res, next) {
  if (!WEBHOOK_SECRET && !LEGACY_TOKEN) {
    console.error(
      'verifyZendeskToken: neither ZENDESK_WEBHOOK_SECRET nor ' +
      'ZENDESK_API_TOKEN is configured - rejecting all webhooks.'
    );
    return res.status(500).json({ error: 'Webhook verification not configured' });
  }

  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);

  if (safeEqual(token, WEBHOOK_SECRET)) {
    return next();
  }

  if (safeEqual(token, LEGACY_TOKEN)) {
    console.warn(
      'verifyZendeskToken: accepted LEGACY api-token secret on ' +
      req.method + ' ' + req.originalUrl + ' - update the Zendesk webhook config.'
    );
    return next();
  }

  return res.status(403).json({ error: 'Forbidden: Invalid token' });
};
