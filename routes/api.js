// src/routes/api.js
const express   = require('express');
const router    = express.Router();
const zendesk   = require('../services/zendesk');

// 🔍 Search users
router.get('/users', async (req, res) => {
  const query = req.query.query || '';
  try {
    const users = await zendesk.searchUsers(query);
    res.json({ users });
  } catch (err) {
    console.error('GET /users failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// 👤 Lookup a single user by ID
router.get('/users/:id', async (req, res) => {
  try {
    const user = await zendesk.getUserById(req.params.id);
    res.json({ user });
  } catch (err) {
    console.error(`GET /users/${req.params.id} failed:`, err);
    res.status(500).json({ error: err.message });
  }
});

// 🏢 List all orgs
router.get('/organizations', async (req, res) => {
  try {
    const organizations = await zendesk.getOrganizations();
    res.json({ organizations });
  } catch (err) {
    console.error('GET /organizations failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// 🏷️ Lookup single org by ID
router.get('/organizations/:id', async (req, res) => {
  try {
    const organization = await zendesk.getOrganizationById(req.params.id);
    res.json({ organization });
  } catch (err) {
    console.error(`GET /organizations/${req.params.id} failed:`, err);
    res.status(500).json({ error: err.message });
  }
});

// 📦 Get assets for a user
router.get('/assets', async (req, res) => {
  const user_id = req.query.user_id;
  if (!user_id) {
    return res.status(400).json({ error: 'Missing user_id' });
  }
  try {
    const assets = await zendesk.getUserAssetsById(user_id);
    res.json({ assets });
  } catch (err) {
    console.error(`GET /assets?user_id=${user_id} failed:`, err);
    res.status(500).json({ error: err.message });
  }
});

// 🔧 Get asset‐object schema (so you can build your Status dropdown)
router.get('/assets/schema', async (req, res) => {
  try {
    const fields = await zendesk.getAssetFields();
    res.json({ fields });
  } catch (err) {
    console.error('GET /assets/schema failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✏️ Update an existing asset
router.patch('/assets/:id', async (req, res) => {
  try {
    const updated = await zendesk.updateAsset(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    console.error(`PATCH /assets/${req.params.id} failed:`, err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
