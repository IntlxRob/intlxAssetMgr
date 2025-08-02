// src/routes/api.js
const express = require('express');
const router = express.Router();
const zendesk = require('../services/zendesk');
const googleSheets = require('../services/googleSheets');
const verifyZendeskToken = require('../middleware/verifyZendeskToken');

// --- AUTH CHECK (optional) ---
router.get('/auth-check', async (req, res) => {
  try {
    const me = await zendesk.getUserById('me');
    res.json({ success: true, user: me });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- USERS ---
// Search users by name/email:  GET /api/users?query=Foo
router.get('/users', async (req, res) => {
  const q = req.query.query || '';
  try {
    const users = await zendesk.searchUsers(q);
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lookup a single user by ID:  GET /api/users/:id
router.get('/users/:id', async (req, res) => {
  try {
    const user = await zendesk.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ORGANIZATIONS ---
// List all orgs:            GET /api/organizations
router.get('/organizations', async (req, res) => {
  try {
    const orgs = await zendesk.getOrganizations();
    res.json({ organizations: orgs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lookup a single org by ID: GET /api/organizations/:id
router.get('/organizations/:id', async (req, res) => {
  try {
    const org = await zendesk.getOrganizationById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    res.json({ organization: org });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ASSETS ---
// Get assets for a given user: GET /api/assets?user_id=123
router.get('/assets', async (req, res) => {
  const userId = req.query.user_id;
  if (!userId) {
    return res.status(400).json({ error: "Missing 'user_id' parameter" });
  }
  try {
    const assets = await zendesk.getUserAssetsById(userId);
    res.json({ assets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new asset:         POST /api/assets
router.post('/assets', async (req, res) => {
  try {
    const created = await zendesk.createAsset(req.body);
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update an asset:             PATCH /api/assets/:id
router.patch('/assets/:id', async (req, res) => {
  try {
    const updated = await zendesk.updateAsset(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- TICKETS ---
// Create ticket (secured):     POST /api/ticket
router.post('/ticket', verifyZendeskToken, async (req, res) => {
  try {
    const ticket = await zendesk.createTicket(req.body);
    res.status(201).json({ ticket });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- CATALOG (Google Sheets) ---
router.get('/catalog', async (req, res) => {
  try {
    const catalog = await googleSheets.getCatalog();
    res.json(catalog);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
