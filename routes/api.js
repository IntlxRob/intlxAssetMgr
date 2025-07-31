// routes/api.js

const express = require('express');
const router = express.Router();
const axios = require('axios');

const zendeskService = require('../services/zendesk');
const googleSheetsService = require('../services/googleSheets');
const verifyZendeskToken = require('../middleware/verifyZendeskToken');

// 🔐 Zendesk auth setup (for inline search)
const {
  ZENDESK_SUBDOMAIN,
  ZENDESK_EMAIL,
  ZENDESK_API_TOKEN: ZENDESK_TOKEN
} = process.env;

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const zendeskHeaders = {
  Authorization: `Basic ${auth}`,
  'Content-Type': 'application/json',
};

// ────────────────────────────────────────────────────────────────────────────────
// Test direct connection to the Zendesk API
// GET /api/test-zendesk
router.get('/test-zendesk', async (req, res) => {
  try {
    const me = await axios.get(`${BASE_URL}/users/me.json`, { headers: zendeskHeaders });
    res.json({ success: true, user: me.data.user });
  } catch (err) {
    console.error('[test-zendesk] Failed:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// Search Zendesk users by name or email
// GET /api/users?query=...
router.get('/users', async (req, res) => {
  const q = (req.query.query || '').trim();
  if (!q) return res.json({ users: [] });

  try {
    const users = await zendeskService.searchUsers(q);
    res.json({ users });
  } catch (err) {
    console.error('[users] Failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// List all Zendesk organizations
// GET /api/organizations
router.get('/organizations', async (req, res) => {
  try {
    const orgs = await zendeskService.getOrganizations();
    res.json({ organizations: orgs });
  } catch (err) {
    console.error('[organizations] Failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch organizations.' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// Fetch the service catalog from Google Sheets
// GET /api/catalog
router.get('/catalog', async (req, res) => {
  try {
    const catalog = await googleSheetsService.getCatalog();
    res.json(catalog);
  } catch (err) {
    console.error('[catalog] Failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch catalog.' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// Fetch asset records.
// If ?user_id= is provided, use the Zendesk “search” API to filter by assigned_to.
// Otherwise, return all assets.
// GET /api/assets?user_id=19092729672343
router.get('/assets', async (req, res) => {
  const userId = req.query.user_id;
  try {
    if (userId) {
      // use Zendesk custom_objects search endpoint
      const { data } = await axios.post(
        `${BASE_URL}/custom_objects/asset/records/search`,
        {
          filter: {
            $and: [
              { 'custom_object_fields.assigned_to': { $eq: userId } }
            ]
          }
        },
        { headers: zendeskHeaders }
      );
      return res.json({ assets: data.custom_object_records || [] });
    } else {
      // fallback: fetch _all_ and return
      const all = await zendeskService.getAllAssets();
      return res.json({ assets: all });
    }
  } catch (err) {
    console.error('[assets] Failed:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch assets.', details: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// Create a new custom‐object asset record
// POST /api/assets
router.post('/assets', async (req, res) => {
  try {
    const asset = await zendeskService.createAsset(req.body);
    res.status(201).json(asset);
  } catch (err) {
    console.error('[assets POST] Failed:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create asset.' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// Update an existing asset record
// PATCH /api/assets/:id
router.patch('/assets/:id', async (req, res) => {
  try {
    const updated = await zendeskService.updateAsset(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    console.error('[assets PATCH] Failed:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to update asset.' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// Create a Zendesk ticket (protected by token middleware)
// POST /api/ticket
router.post('/ticket', verifyZendeskToken, async (req, res) => {
  try {
    const ticket = await zendeskService.createTicket(req.body);
    res.status(201).json(ticket);
  } catch (err) {
    console.error('[ticket] Failed:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create ticket.' });
  }
});

module.exports = router;
