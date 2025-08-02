const express = require('express');
const router  = express.Router();
const zendesk = require('../services/zendesk');

// ————————————————————————————————
// User endpoints
// GET  /api/users?query=<name>
// GET  /api/users/:id
router.get('/users', async (req, res) => {
  const q = req.query.query || '';
  try {
    const users = await zendesk.searchUsers(q);
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Failed to search users.' });
  }
});

router.get('/users/:id', async (req, res) => {
  try {
    const user = await zendesk.getUserById(req.params.id);
    res.json({ user });
  } catch {
    res.status(500).json({ error: 'Failed to fetch user.' });
  }
});

// ————————————————————————————————
// Organization endpoints
// GET  /api/organizations
// GET  /api/organizations/:id
router.get('/organizations', async (req, res) => {
  try {
    const orgs = await zendesk.getOrganizations();
    res.json({ organizations: orgs });
  } catch {
    res.status(500).json({ error: 'Failed to list organizations.' });
  }
});

router.get('/organizations/:id', async (req, res) => {
  try {
    const org = await zendesk.getOrganizationById(req.params.id);
    res.json({ organization: org });
  } catch {
    res.status(500).json({ error: 'Failed to fetch organization.' });
  }
});

// ————————————————————————————————
// Asset endpoints
// GET  /api/assets?user_id=<ZendeskUserID>
// POST /api/assets
// PATCH /api/assets/:id
router.get('/assets', async (req, res) => {
  const userId = req.query.user_id;
  if (!userId) return res.status(400).json({ error: 'Missing user_id param.' });
  try {
    const assets = await zendesk.getUserAssetsById(userId);
    res.json({ assets });
  } catch {
    res.status(500).json({ error: 'Failed to fetch assets.' });
  }
});

router.post('/assets', async (req, res) => {
  try {
    const created = await zendesk.createAsset(req.body);
    res.status(201).json(created);
  } catch {
    res.status(500).json({ error: 'Failed to create asset.' });
  }
});

router.patch('/assets/:id', async (req, res) => {
  try {
    const updated = await zendesk.updateAsset(req.params.id, req.body);
    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Failed to update asset.' });
  }
});

// ————————————————————————————————
// Ticket creation
// POST /api/ticket
router.post('/ticket', async (req, res) => {
  try {
    const ticket = await zendesk.createTicket(req.body);
    res.status(201).json({ ticket });
  } catch {
    res.status(500).json({ error: 'Failed to create ticket.' });
  }
});

module.exports = router;
