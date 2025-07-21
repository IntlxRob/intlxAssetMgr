const express = require('express');
const router = express.Router();
const zendeskService = require('../services/zendesk');

// Existing routes ...

// Fetch all users
router.get('/users', async (req, res) => {
  try {
    const users = await zendeskService.getUsers();
    res.json({ users });
  } catch (err) {
    console.error('Error fetching users:', err.message);
    res.status(500).json({ error: 'Failed to fetch users.', details: err.message });
  }
});

// Fetch all organizations
router.get('/organizations', async (req, res) => {
  try {
    const organizations = await zendeskService.getOrganizations();
    res.json({ organizations });
  } catch (err) {
    console.error('Error fetching organizations:', err.message);
    res.status(500).json({ error: 'Failed to fetch organizations.', details: err.message });
  }
});

module.exports = router;
