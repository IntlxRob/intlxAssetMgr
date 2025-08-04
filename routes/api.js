// src/routes/api.js
const express = require('express');
const router  = express.Router();
const zendesk = require('../services/zendesk');

// 🔍 Search users by query string
router.get('/users', async (req, res) => {
  const query = req.query.query || '';
  try {
    const users = await zendesk.searchUsers(query);
    res.json({ users });
  } catch (err) {
    console.error('Error in GET /users:', err);
    res.status(500).json({ error: err.message });
  }
});

// 👤 Lookup a single user by ID
router.get('/users/:id', async (req, res) => {
  try {
    const user = await zendesk.getUserById(req.params.id);
    res.json({ user });
  } catch (err) {
    console.error('Error in GET /users/:id:', err);
    res.status(500).json({ error: err.message });
  }
});

// 🏢 List all organizations
router.get('/organizations', async (req, res) => {
  try {
    const orgs = await zendesk.getOrganizations();
    res.json({ organizations: orgs });
  } catch (err) {
    console.error('Error in GET /organizations:', err);
    res.status(500).json({ error: err.message });
  }
});

// 🏷️ Lookup single organization by ID
router.get('/organizations/:id', async (req, res) => {
  try {
    const organization = await zendesk.getOrganizationById(req.params.id);
    res.json({ organization });
  } catch (err) {
    console.error('Error in GET /organizations/:id:', err);
    res.status(500).json({ error: err.message });
  }
});

// 📦 Get all assets assigned to a given user
router.get('/assets', async (req, res) => {
  const user_id = req.query.user_id;
  if (!user_id) {
    return res.status(400).json({ error: 'Missing user_id parameter' });
  }
  try {
    const assets = await zendesk.getUserAssetsById(user_id);
    res.json({ assets });
  } catch (err) {
    console.error('Error in GET /assets:', err);
    res.status(500).json({ error: err.message });
  }
});

// 🔧 Fetch the asset custom-object schema (e.g. to build your status dropdown)
router.get('/assets/schema', async (req, res) => {
  try {
    const fields = await zendesk.getAssetFields();
    res.json({ fields });
  } catch (err) {
    console.error('Error in GET /assets/schema:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✏️ Update an asset record
router.patch('/assets/:id', async (req, res) => {
  try {
    const updated = await zendesk.updateAsset(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    console.error('Error in PATCH /assets/:id:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
