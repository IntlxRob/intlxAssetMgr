// routes/api.js
const express = require('express');
const router  = express.Router();
const zendesk = require('../services/zendesk');

// ─────────────────────────────────────────────────────────────────────────────
// Search users by name/email
// GET /api/users?query=rob
// ─────────────────────────────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  const q = req.query.query || '';
  try {
    const users = await zendesk.searchUsers(q);
    res.json({ users });
  } catch (err) {
    console.error('[GET /api/users] ', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Lookup single user by ID
// GET /api/users/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/users/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const user = await zendesk.getUserById(id);
    res.json({ user });
  } catch (err) {
    console.error('[GET /api/users/:id] ', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// List all organizations
// GET /api/organizations
// ─────────────────────────────────────────────────────────────────────────────
router.get('/organizations', async (req, res) => {
  try {
    const organizations = await zendesk.getOrganizations();
    res.json({ organizations });
  } catch (err) {
    console.error('[GET /api/organizations] ', err);
    res.status(500).json({ error: 'Failed to fetch organizations' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Lookup single organization by ID
// GET /api/organizations/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/organizations/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const organization = await zendesk.getOrganizationById(id);
    res.json({ organization });
  } catch (err) {
    console.error('[GET /api/organizations/:id] ', err);
    res.status(500).json({ error: 'Failed to fetch organization' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Asset Schema (to drive status dropdown, etc.)
// GET /api/assets/schema
// ─────────────────────────────────────────────────────────────────────────────
router.get('/assets/schema', async (req, res) => {
  try {
    const schema = await zendesk.getAssetSchema();
    res.json({ schema });
  } catch (err) {
    console.error('[GET /api/assets/schema] ', err);
    res.status(500).json({ error: 'Failed to fetch asset schema' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Get assets assigned to a given user
// GET /api/user-assets?user_id=190927...
// ─────────────────────────────────────────────────────────────────────────────
router.get('/user-assets', async (req, res) => {
  const userId = req.query.user_id;
  if (!userId) {
    return res.status(400).json({ error: "Missing 'user_id' parameter" });
  }
  try {
    const assets = await zendesk.getUserAssetsById(userId);
    res.json({ assets });
  } catch (err) {
    console.error('[GET /api/user-assets] ', err);
    res.status(500).json({ error: 'Failed to fetch user assets' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Create a new asset record
// POST /api/assets
// body: { <custom_object_fields> }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/assets', async (req, res) => {
  try {
    const result = await zendesk.createAsset(req.body);
    res.status(201).json(result);
  } catch (err) {
    console.error('[POST /api/assets] ', err);
    res.status(500).json({ error: 'Failed to create asset' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Update an existing asset record
// PATCH /api/assets/:id
// body: { <custom_object_fields> }
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/assets/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const result = await zendesk.updateAsset(id, req.body);
    res.json(result);
  } catch (err) {
    console.error('[PATCH /api/assets/:id] ', err);
    res.status(500).json({ error: 'Failed to update asset' });
  }
});

module.exports = router;
