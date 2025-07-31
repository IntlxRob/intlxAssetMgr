// routes/api.js
const express = require('express');
const router = express.Router();
const zendesk = require('../services/zendesk');

/**
 * Search users by name or email
 * GET /api/users?query=
 */
router.get('/users', async (req, res) => {
  const q = (req.query.query || '').trim();
  if (!q) return res.json({ users: [] });
  try {
    const users = await zendesk.searchUsers(q);
    res.json({ users });
  } catch (e) {
    console.error('[API] /users error', e);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * Get all organizations
 * GET /api/organizations
 */
router.get('/organizations', async (req, res) => {
  try {
    const organizations = await zendesk.getOrganizations();
    res.json({ organizations });
  } catch (e) {
    console.error('[API] /organizations error', e);
    res.status(500).json({ error: 'Failed to fetch organizations' });
  }
});

/**
 * Get all asset records, optionally filtered by assigned_to (user_id)
 * GET /api/assets?user_id=
 */
router.get('/assets', async (req, res) => {
  try {
    // Fetch from Zendesk custom_objects
    const allRecords = await zendesk.getAllAssets(); // returns array of records

    // If user_id provided, filter by assigned_to field
    const { user_id } = req.query;
    let assets = allRecords;
    if (user_id) {
      assets = allRecords.filter(record => {
        const assignedTo = record.custom_object_fields?.assigned_to || record.attributes?.assigned_to;
        return String(assignedTo) === String(user_id);
      });
    }

    res.json({ assets });
  } catch (e) {
    console.error('[API] /assets error', e);
    res.status(500).json({ error: 'Failed to fetch assets' });
  }
});

module.exports = router;
