// src/routes/api.js

const express = require('express');
const router  = express.Router();
const zendesk = require('../services/zendesk');

// 🔍 Search users
router.get('/users', async (req, res) => {
  const q = req.query.query || '';
  try {
    const users = await zendesk.searchUsers(q);
    res.json({ users });
  } catch (err) {
    console.error('[GET /users] Error:', err);
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

// 🏢 Get organizations
router.get('/organizations', async (_req, res) => {
  try {
    const orgs = await zendesk.getOrganizations();
    res.json({ organizations: orgs });
  } catch (err) {
    console.error('[GET /organizations] Error:', err);
    res.status(500).json({ error: 'Failed to fetch organizations.' });
  }
});

// 📦 Get assets for a user
router.get('/assets', async (req, res) => {
  const userId = req.query.user_id;
  if (!userId) {
    return res.status(400).json({ error: "Missing 'user_id' parameter." });
  }
  try {
    const assets = await zendesk.getUserAssetsById(userId);
    res.json({ assets });
  } catch (err) {
    console.error('[GET /assets] Error:', err);
    res.status(500).json({ error: 'Failed to fetch user assets.' });
  }
});

// 🛠️ Update an asset
router.patch('/assets/:id', async (req, res) => {
  try {
    const updated = await zendesk.updateAsset(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    console.error('[PATCH /assets/:id] Error:', err);
    res.status(500).json({ error: 'Failed to update asset.' });
  }
});

// ➕ Create an asset
router.post('/assets', async (req, res) => {
  try {
    const created = await zendesk.createAsset(req.body);
    res.status(201).json(created);
  } catch (err) {
    console.error('[POST /assets] Error:', err);
    res.status(500).json({ error: 'Failed to create asset.' });
  }
});

// 📋 Fetch the custom-object fields (for dropdowns)
router.get('/assets/fields', async (_req, res) => {
  try {
    const fields = await zendesk.getAssetFields();
    res.json({ fields });
  } catch (err) {
    console.error('[GET /assets/fields] Error:', err);
    res.status(500).json({ error: 'Failed to fetch asset fields.' });
  }
});

// 🎫 Create a ticket
router.post('/ticket', async (req, res) => {
  try {
    const ticket = await zendesk.createTicket(req.body);
    res.status(201).json(ticket);
  } catch (err) {
    console.error('[POST /ticket] Error:', err);
    res.status(500).json({ error: 'Failed to create ticket.' });
  }
});

module.exports = router;
