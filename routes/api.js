// routes/api.js
const express = require('express');
const router  = express.Router();
const zendesk = require('../services/zendesk');

// 🔍 Search users
router.get('/users', async (req, res) => {
  try {
    const users = await zendesk.searchUsers(req.query.query || '');
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 👤 Lookup user by ID
router.get('/users/:id', async (req, res) => {
  try {
    const user = await zendesk.getUserById(req.params.id);
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🏢 List orgs
router.get('/organizations', async (req, res) => {
  try {
    const orgs = await zendesk.getOrganizations();
    res.json({ organizations: orgs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🏷 Lookup org by ID
router.get('/organizations/:id', async (req, res) => {
  try {
    const organization = await zendesk.getOrganizationById(req.params.id);
    res.json({ organization });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 📦 Get assets for a user
router.get('/assets', async (req, res) => {
  const user_id = req.query.user_id;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });
  try {
    const assets = await zendesk.getUserAssetsById(user_id);
    res.json({ assets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🔧 Get asset-field schema (for status dropdown)
router.get('/assets/schema', async (req, res) => {
  try {
    const fields = await zendesk.getAssetFields();
    res.json({ fields });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✏️ Update an asset
router.patch('/assets/:id', async (req, res) => {
  try {
    const updated = await zendesk.updateAsset(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
