// src/routes/api.js
const express   = require('express');
const router    = express.Router();
const zendesk   = require('../services/zendesk');

// 🔍 Search users by query (name/email)
router.get('/users', async (req, res) => {
  const query = req.query.query || '';
  try {
    const users = await zendesk.searchUsers(query);
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 👤 Lookup a single user by ID
router.get('/users/:id', async (req, res) => {
  try {
    const user = await zendesk.getUserById(req.params.id);
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🏢 List all orgs
router.get('/organizations', async (req, res) => {
  try {
    const orgs = await zendesk.getOrganizations();
    res.json({ organizations: orgs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🏷️ Lookup single org by ID
router.get('/organizations/:id', async (req, res) => {
  try {
    const organization = await zendesk.getOrganizationById(req.params.id);
    res.json({ organization });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 📦 Get all assets (unfiltered)
router.get('/assets/all', async (req, res) => {
  try {
    const assets = await zendesk.getAllAssets();
    res.json({ assets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 📦 Get assets assigned to a specific user
router.get('/assets', async (req, res) => {
  const user_id = req.query.user_id;
  if (!user_id) {
    return res.status(400).json({ error: 'Missing user_id query parameter' });
  }
  try {
    const assets = await zendesk.getUserAssetsById(user_id);
    res.json({ assets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🔧 Get asset‐fields schema (for building your dropdowns)
router.get('/assets/schema', async (req, res) => {
  try {
    const fields = await zendesk.getAssetFields();
    res.json({ fields });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✏️ Update an asset record
router.patch('/assets/:id', async (req, res) => {
  try {
    const updated = await zendesk.updateAsset(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ➕ Create a new asset record
router.post('/assets', async (req, res) => {
  try {
    const created = await zendesk.createAsset(req.body);
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🎫 Create a new Zendesk ticket
router.post('/ticket', async (req, res) => {
  try {
    const ticket = await zendesk.createTicket(req.body);
    res.status(201).json({ ticket });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
