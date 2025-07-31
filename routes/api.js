// routes/api.js
const express = require('express');
const router = express.Router();
const zendesk = require('../services/zendesk');
const googleSheets = require('../services/googleSheets');
const verifyZendeskToken = require('../middleware/verifyZendeskToken');

// 🔍 Fetch a single user by ID
router.get('/users/:id', async (req, res) => {
  try {
    const user = await zendesk.searchUserById(req.params.id);
    res.json({ user });
  } catch (err) {
    console.error('[GET /api/users/:id]', err.message);
    res.status(500).json({ error: 'Failed to fetch user.' });
  }
});

// 🏢 Fetch a single organization by ID
router.get('/organizations/:id', async (req, res) => {
  try {
    const organization = await zendesk.getOrganizationById(req.params.id);
    res.json({ organization });
  } catch (err) {
    console.error('[GET /api/organizations/:id]', err.message);
    res.status(500).json({ error: 'Failed to fetch organization.' });
  }
});

// 📦 List assets assigned to a user
router.get('/user-assets', async (req, res) => {
  const userId = req.query.user_id;
  if (!userId) {
    return res.status(400).json({ error: 'Missing user_id query parameter.' });
  }
  try {
    const assets = await zendesk.getUserAssetsById(userId);
    res.json({ assets });
  } catch (err) {
    console.error('[GET /api/user-assets]', err.message);
    res.status(500).json({ error: 'Failed to fetch user assets.' });
  }
});

// 🗂️ Return asset schema (for dropdown/enums)
router.get('/assets/schema', async (req, res) => {
  try {
    const schema = await zendesk.getAssetSchema();
    res.json({ schema });
  } catch (err) {
    console.error('[GET /api/assets/schema]', err.message);
    res.status(500).json({ error: 'Failed to fetch asset schema.' });
  }
});

// ✏️ Update a single asset record
router.patch('/assets/:id', verifyZendeskToken, async (req, res) => {
  try {
    const updated = await zendesk.updateAsset(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    console.error('[PATCH /api/assets/:id]', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to update asset.' });
  }
});

module.exports = router;
