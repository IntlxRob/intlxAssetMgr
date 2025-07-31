// routes/api.js
const express = require('express');
const router = express.Router();
const zendesk = require('../services/zendesk');
const googleSheets = require('../services/googleSheets');

// Health‐check / debug
router.get('/test-zendesk', async (req, res) => {
  try {
    const me = await zendesk.getCurrentUser();
    res.json({ success: true, me });
  } catch (err) {
    console.error('Zendesk test failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Fetch catalog from Google Sheets
router.get('/catalog', async (req, res) => {
  try {
    const catalog = await googleSheets.getCatalog();
    res.json(catalog);
  } catch (err) {
    console.error('Google Sheets error', err);
    res.status(500).json({ error: err.message });
  }
});

// Fetch a single user’s details by Zendesk ID
router.get('/users/:id', async (req, res) => {
  try {
    const user = await zendesk.getUserById(req.params.id);
    res.json({ user });
  } catch (err) {
    console.error(`GET /api/users/${req.params.id} failed`, err);
    res.status(500).json({ error: err.message });
  }
});

// Fetch a single organization by Zendesk ID
router.get('/organizations/:id', async (req, res) => {
  try {
    const organization = await zendesk.getOrganizationById(req.params.id);
    res.json({ organization });
  } catch (err) {
    console.error(`GET /api/organizations/${req.params.id} failed`, err);
    res.status(500).json({ error: err.message });
  }
});

// Fetch all assets assigned to a user
router.get('/user-assets', async (req, res) => {
  const userId = req.query.user_id;
  if (!userId) return res.status(400).json({ error: 'Missing user_id' });

  try {
    const assets = await zendesk.getUserAssetsById(userId);
    res.json({ assets });
  } catch (err) {
    console.error('Error fetching user assets', err);
    res.status(500).json({ error: err.message });
  }
});

// Fetch raw asset schema (for your “status” dropdown, etc.)
router.get('/assets/schema', async (req, res) => {
  try {
    const schema = await zendesk.getAssetSchema();
    res.json(schema);
  } catch (err) {
    console.error('Error fetching asset schema', err);
    res.status(500).json({ error: err.message });
  }
});

// Create a brand‐new asset
router.post('/assets', async (req, res) => {
  try {
    const newAsset = await zendesk.createAsset(req.body);
    res.status(201).json(newAsset);
  } catch (err) {
    console.error('Error POST /api/assets', err);
    res.status(500).json({ error: err.message });
  }
});

// Update an existing asset’s fields
router.patch('/assets/:id', async (req, res) => {
  try {
    const updated = await zendesk.updateAsset(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    console.error(`Error PATCH /api/assets/${req.params.id}`, err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
