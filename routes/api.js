// routes/api.js
const express = require('express');
const router = express.Router();
const zendeskService = require('../services/zendesk');
const googleSheetsService = require('../services/googleSheets');

/**
 * Test Zendesk API connection
 */
router.get('/test-zendesk', async (req, res) => {
  try {
    const data = await zendeskService.testConnection();
    res.status(200).json({ success: true, message: 'Successfully connected to Zendesk API.', data });
  } catch (error) {
    console.error('!!!!!!!! ZENDESK API TEST FAILED !!!!!!!!', error.message);
    res.status(500).json({ success: false, message: 'Failed to connect to Zendesk API.', error: error.message });
  }
});

/**
 * Endpoint to fetch the service catalog from Google Sheets.
 */
router.get('/catalog', async (req, res) => {
  try {
    const catalog = await googleSheetsService.getCatalog();
    res.json(catalog);
  } catch (error) {
    console.error('Error fetching catalog:', error.message);
    res.status(500).json({ error: 'Failed to fetch catalog from Google Sheets.', details: error.message });
  }
});

/**
 * Fetch all users
 */
router.get('/users', async (req, res) => {
  try {
    const users = await zendeskService.getAllUsers();
    res.json({ users });
  } catch (error) {
    console.error('Error fetching users:', error.message);
    res.status(500).json({ error: 'Failed to fetch users.', details: error.message });
  }
});

/**
 * Fetch all organizations
 */
router.get('/organizations', async (req, res) => {
  try {
    const organizations = await zendeskService.getAllOrganizations();
    res.json({ organizations });
  } catch (error) {
    console.error('Error fetching organizations:', error.message);
    res.status(500).json({ error: 'Failed to fetch organizations.', details: error.message });
  }
});

/**
 * Get assets assigned to a specific user (user_id via query param)
 */
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

/**
 * Create a new asset
 */
router.post('/assets', async (req, res) => {
  try {
    const assetData = req.body;
    const result = await zendeskService.createAsset(assetData);
    res.status(201).json(result);
  } catch (error) {
    console.error('Error creating asset:', error.message);
    res.status(500).json({ error: 'Failed to create asset.', details: error.message });
  }
});

/**
 * Update an existing asset by ID
 */
router.patch('/assets/:id', async (req, res) => {
  const assetId = req.params.id;
  const fieldsToUpdate = req.body;
  try {
    const result = await zendeskService.updateAsset(assetId, fieldsToUpdate);
    res.status(200).json(result);
  } catch (error) {
    console.error(`Error updating asset ${assetId}:`, error.message);
    res.status(500).json({ error: 'Failed to update asset.', details: error.message });
  }
});

/**
 * Create a new ticket and associated assets
 */
router.post('/ticket', async (req, res) => {
  try {
    console.log("🔧 Incoming ticket request body:", req.body);
    const { name, email, subject, assets = [], approved_by } = req.body;

    if (!email || assets.length === 0) {
      return res.status(400).json({ error: 'Missing email or assets.' });
    }

    // 1. Lookup requester
    const users = await zendeskService.getAllUsers();
    const requester = users.find((u) => u.email === email);
    if (!requester) {
      return res.status(404).json({ error: `Requester not found for email ${email}` });
    }

    // 2. Format assets for Zendesk custom object creation
    const formattedAssets = assets.map((asset, index) => ({
      name: asset.asset_name || `asset-${Date.now()}-${index}`,
      custom_object_fields: {
       asset_name: asset.asset_name || '',
       manufacturer: asset.manufacturer || '',
       model_number: asset.model_number || '',
       description: asset.description || '',
       url: asset.url || '',
       serial_number: asset.serial_number || '',
       status: asset.status || 'Pending',
       approved_by: approved_by || name,
       assigned_to: requester.id,
       organization: requester.organization_id || null,
    }

    }));

    // 3. Create ticket and assets
    const result = await zendeskService.createTicketAndAssets({
      subject: subject || 'New Asset Catalog Request',
      description: `Requested by ${name || email}`,
      requester_id: requester.id,
      assets: formattedAssets
    });

    res.status(201).json({ ticket: { id: result.ticket_id }, assets: result.assets });
  } catch (error) {
    console.error('Error creating ticket and assets:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to create ticket and assets.', details: error.message });
  }
});

module.exports = router;
