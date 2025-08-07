// routes/api.js
const express = require('express');
const router = express.Router();
const zendesk = require('../services/zendesk');

// 🎯 Search users by name/email
router.get('/users/search', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Missing query parameter' });

    const users = await zendesk.searchUsers(query);
    res.json({ users });
  } catch (err) {
    console.error('Error searching users:', err.message);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

// 🏢 Search organizations by name
router.get('/organizations/search', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Missing query parameter' });

    const organizations = await zendesk.searchOrganizations(query);
    res.json({ organizations });
  } catch (err) {
    console.error('Error searching organizations:', err.message);
    res.status(500).json({ error: 'Failed to search organizations' });
  }
});

// 📦 Get all assets assigned to a user
router.get('/assets', async (req, res) => {
  try {
    const userId = req.query.user_id;
    if (!userId) return res.status(400).json({ error: 'Missing user_id parameter' });

    const assets = await zendesk.getUserAssetsById(userId);
    res.json({ assets });
  } catch (err) {
    console.error('Error fetching user assets:', err.message);
    res.status(500).json({ error: 'Failed to fetch assets' });
  }
});

// 📦 Update an asset by ID
router.patch('/assets/:id', async (req, res) => {
  try {
    const assetId = req.params.id;
    const attrs = req.body;
    const result = await zendesk.updateAsset(assetId, attrs);
    res.json(result);
  } catch (err) {
    console.error('Error updating asset:', err.message);
    res.status(500).json({ error: 'Failed to update asset' });
  }
});

// 🧠 Fetch schema (used for status options)
router.get('/assets/schema', async (req, res) => {
  try {
    const fields = await zendesk.getAssetFields();
    res.json({ fields });
  } catch (err) {
    console.error('Error fetching asset schema:', err.message);
    res.status(500).json({ error: 'Failed to fetch schema' });
  }
});

// 🔍 Get organization by ID
router.get('/organizations/:id', async (req, res) => {
  try {
    const orgId = req.params.id;
    const organization = await zendesk.getOrganizationById(orgId);
    res.json({ organization });
  } catch (err) {
    console.error('Error fetching organization:', err.message);
    res.status(500).json({ error: 'Failed to fetch organization' });
  }
});

// 👤 Get user by ID
router.get('/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await zendesk.getUserById(userId);
    res.json({ user });
  } catch (err) {
    console.error('Error fetching user:', err.message);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

module.exports = router;
