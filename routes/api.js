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
    console.error('ZENDESK API TEST FAILED:', error.message);
    res.status(500).json({ success: false, message: 'Failed to connect to Zendesk API.', error: error.message });
  }
});

/**
 * Fetch catalog from Google Sheets
 */
router.get('/catalog', async (req, res) => {
  try {
    const catalog = await googleSheetsService.getCatalog();
    res.json(catalog);
  } catch (error) {
    console.error('Error fetching catalog:', error.message);
    res.status(500).json({ error: 'Failed to fetch catalog.', details: error.message });
  }
});

/**
 * Get Zendesk user (requester) details
 */
router.get('/requester/:id', async (req, res) => {
  try {
    const user = await zendeskService.getUserById(req.params.id);
    res.json({ user });
  } catch (error) {
    console.error('Error fetching requester:', error.message);
    res.status(500).json({ error: 'Failed to fetch requester.', details: error.message });
  }
});

/**
 * Get Zendesk organization details
 */
router.get('/organization/:id', async (req, res) => {
  try {
    const organization = await zendeskService.getOrganizationById(req.params.id);
    res.json({ organization });
  } catch (error) {
    console.error('Error fetching organization:', error.message);
    res.status(500).json({ error: 'Failed to fetch organization.', details: error.message });
  }
});

/**
 * Get assets assigned to user (by user_id query param)
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
 * Create a new asset record
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
 * Update asset by ID
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
 * Create a ticket (initial request submission from catalog page)
 */
router.post('/ticket', async (req, res) => {
  try {
    const { name, email, subject, body } = req.body;
    if (!email || !body) {
      return res.status(400).json({ error: 'Missing email or ticket body.' });
    }

    console.log('Incoming ticket request:', req.body);

    const users = await zendeskService.getAllUsers();
    const requester = users.find((u) => u.email === email);
    if (!requester) {
      return res.status(404).json({ error: `Requester not found for email ${email}` });
    }

    const ticketPayload = {
      ticket: {
        subject: subject || 'New Service Catalog Request',
        comment: { html_body: body },
        requester_id: requester.id,
      }
    };

    const ticketRes = await zendeskService.zendeskApi.post('/tickets.json', ticketPayload);
    const ticketId = ticketRes.data.ticket.id;

    res.status(201).json({ ticket: { id: ticketId } });
  } catch (error) {
    console.error('Error creating ticket:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to create ticket.', details: error.message });
  }
});

module.exports = router;
