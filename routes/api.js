// routes/api.js
const express = require('express');
const router = express.Router();
const zendeskService = require('../services/zendesk');  // ensure correct import
const googleSheetsService = require('../services/googleSheets'); // if you have this service for catalog

// Test Zendesk connection
router.get('/test-zendesk', async (req, res) => {
  try {
    const data = await zendeskService.testConnection();
    res.status(200).json({ success: true, message: 'Successfully connected to Zendesk API.', data });
  } catch (error) {
    console.error('!!!!!!!! ZENDESK API TEST FAILED !!!!!!!!', error);
    res.status(500).json({ success: false, message: 'Failed to connect to Zendesk API.', error: error.message });
  }
});

// Fetch service catalog
router.get('/catalog', async (req, res) => {
  try {
    const catalog = await googleSheetsService.getCatalog();
    res.json(catalog);
  } catch (error) {
    console.error('Error fetching catalog:', error.message);
    res.status(500).json({ error: 'Failed to fetch catalog from Google Sheets.', details: error.message });
  }
});

// Create ticket + assets
router.post('/ticket', async (req, res) => {
  try {
    const result = await zendeskService.createTicketAndAssets(req.body);
    res.status(201).json(result);
  } catch (error) {
    console.error('Error in /api/ticket POST:', error.message);
    res.status(500).json({ error: 'Failed to process request.', details: error.message });
  }
});

// Get assets for user
router.get('/user-assets', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) {
    return res.status(400).json({ error: 'Missing user_id query parameter.' });
  }
  try {
    const assets = await zendeskService.getUserAssets(user_id);
    res.json({ assets });
  } catch (error) {
    console.error('Error fetching user assets:', error.message);
    res.status(500).json({ error: 'Failed to fetch user assets.', details: error.message });
  }
});

// Create new asset
router.post('/assets', async (req, res) => {
  try {
    const assetData = req.body;
    const result = await zendeskService.createAsset(assetData);
    res.status(201).json(result);
  } catch (error) {
    console.error('Error in /api/assets POST:', error.message, error.response?.data);
    res.status(500).json({ error: 'Failed to create asset.', details: error.message });
  }
});

// Update asset
router.patch('/assets/:id', async (req, res) => {
  const assetId = req.params.id;
  const fieldsToUpdate = req.body;
  try {
    const result = await zendeskService.updateAsset(assetId, fieldsToUpdate);
    res.status(200).json(result);
  } catch (error) {
    console.error('Error in /api/assets/:id PATCH:', error.message, error.response?.data);
    res.status(500).json({ error: 'Failed to update asset.', details: error.message });
  }
});

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
