// src/routes/api.js

const express = require('express');
const router = express.Router();
const zendesk = require('../services/zendesk');

// ————————————————————————————
// User endpoints
// ————————————————————————————

/**
 * Search users by name/email
 */
router.get('/users', async (req, res) => {
  const query = req.query.query || '';
  const users = await zendesk.searchUsers(query);
  res.json({ users });
});

/**
 * Get a single user by ID
 */
router.get('/users/:id', async (req, res) => {
  try {
    const user = await zendesk.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ————————————————————————————
// Organization endpoints
// ————————————————————————————

/**
 * List all organizations
 */
router.get('/organizations', async (req, res) => {
  const orgs = await zendesk.getOrganizations();
  res.json({ organizations: orgs });
});

/**
 * Get a single organization by ID
 */
router.get('/organizations/:id', async (req, res) => {
  try {
    const org = await zendesk.getOrganizationById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    res.json({ organization: org });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ————————————————————————————
// Asset endpoints
// ————————————————————————————

/**
 * Get all assets for a given user ID
 */
router.get('/assets', async (req, res) => {
  const userId = req.query.user_id;
  if (!userId) {
    return res.status(400).json({ error: 'Missing user_id parameter' });
  }
  const assets = await zendesk.getUserAssetsById(userId);
  res.json({ assets });
});

/**
 * Update one asset record
 */
router.patch('/assets/:id', async (req, res) => {
  try {
    const data = await zendesk.updateAsset(req.params.id, req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// (You already have a POST /assets and POST /ticket elsewhere)

module.exports = router;
