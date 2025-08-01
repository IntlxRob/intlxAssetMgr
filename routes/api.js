// routes/api.js

const express = require('express');
const router = express.Router();
const zendeskService = require('../services/zendesk');
const googleSheetsService = require('../services/googleSheets');
const verifyZendeskToken = require('../middleware/verifyZendeskToken');

// — User lookups —

// Search users by name or email
router.get('/users', async (req, res) => {
  const q = req.query.query || '';
  try {
    const users = await zendeskService.searchUsers(q);
    res.json({ users });
  } catch (err) {
    console.error('[GET /users] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

// Get single user by ID
router.get('/users/:id', async (req, res) => {
  try {
    const user = await zendeskService.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ user });
  } catch (err) {
    console.error('[GET /users/:id] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch user.' });
  }
});

// — Organization lookups —

// List all organizations
router.get('/organizations', async (req, res) => {
  try {
    const orgs = await zendeskService.getOrganizations();
    res.json({ organizations: orgs });
  } catch (err) {
    console.error('[GET /organizations] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch organizations.' });
  }
});

// Get single organization by ID
router.get('/organizations/:id', async (req, res) => {
  try {
    const org = await zendeskService.getOrganizationById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Organization not found.' });
    res.json({ organization: org });
  } catch (err) {
    console.error('[GET /organizations/:id] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch organization.' });
  }
});

// — Asset CRUD —

// Get all asset records
router.get('/assets', async (req, res) => {
  try {
    const assets = await zendeskService.getAllAssets();
    res.json({ assets });
  } catch (err) {
    console.error('[GET /assets] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch assets.' });
  }
});

// Get assets assigned to a user by user_id
router.get('/assets/user/:userId', async (req, res) => {
  try {
    const assets = await zendeskService.getUserAssetsById(req.params.userId);
    res.json({ assets });
  } catch (err) {
    console.error('[GET /assets/user/:userId] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch user assets.' });
  }
});

// Get the custom-object schema (definition)
router.get('/assets/schema', async (req, res) => {
  try {
    const schema = await zendeskService.getAssetSchema();
    res.json({ schema });
  } catch (err) {
    console.error('[GET /assets/schema] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch asset schema.' });
  }
});

// Get all field definitions (for dropdowns, etc.)
router.get('/assets/fields', async (req, res) => {
  try {
    const fields = await zendeskService.getAssetFields();
    res.json({ fields });
  } catch (err) {
    console.error('[GET /assets/fields] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch asset fields.' });
  }
});

// Create a new asset record
router.post('/assets', async (req, res) => {
  try {
    const record = await zendeskService.createAsset(req.body);
    res.status(201).json(record);
  } catch (err) {
    console.error('[POST /assets] Error:', err.message);
    res.status(500).json({ error: 'Failed to create asset.' });
  }
});

// Update an existing asset record
router.patch('/assets/:id', async (req, res) => {
  try {
    const updated = await zendeskService.updateAsset(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    console.error('[PATCH /assets/:id] Error:', err.message);
    res.status(500).json({ error: 'Failed to update asset.' });
  }
});

// — Tickets —

// Create a Zendesk ticket (optionally protected)
router.post('/tickets', verifyZendeskToken, async (req, res) => {
  try {
    const ticket = await zendeskService.createTicket(req.body);
    res.status(201).json({ ticket });
  } catch (err) {
    console.error('[POST /tickets] Error:', err.message);
    res.status(500).json({ error: 'Failed to create ticket.' });
  }
});

// — Google Sheets catalog —

// Fetch the service catalog from Google Sheets
router.get('/catalog', async (req, res) => {
  try {
    const catalog = await googleSheetsService.getCatalog();
    res.json(catalog);
  } catch (err) {
    console.error('[GET /catalog] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch catalog.' });
  }
});

module.exports = router;
