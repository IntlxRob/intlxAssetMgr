const express = require('express');
const router = express.Router();
const axios = require('axios');
const zendeskService = require('../services/zendesk');
const googleSheetsService = require('../services/googleSheets');
const verifyZendeskToken = require('../middleware/verifyZendeskToken');

// 🔐 Zendesk Auth Setup
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN = process.env.ZENDESK_API_TOKEN; // ✅ Corrected variable name
const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;

const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${auth}`,
  'Content-Type': 'application/json',
};

// 🔐 Auth Check
router.get("/auth-check", async (req, res) => {
  console.debug("[DEBUG] /auth-check called");

  try {
    const response = await axios.get(`${BASE_URL}/users/me.json`, { headers });
    const user = response.data.user;
    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    console.error("[AUTH-CHECK] Failed:", error.response?.status, error.response?.data);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

// 🔍 Get all users
router.get("/users", async (req, res) => {
  try {
    const users = await zendeskService.searchUsers(req.query.query || "");
    res.json({ users });
  } catch (error) {
    console.error("Error fetching users:", error.message);
    res.status(500).json({ error: "Failed to fetch users." });
  }
});

// 🔍 Get all organizations
router.get("/organizations", async (req, res) => {
  try {
    const orgs = await zendeskService.getOrganizations();
    res.json({ organizations: orgs });
  } catch (error) {
    console.error("Error fetching organizations:", error.message);
    res.status(500).json({ error: "Failed to fetch organizations." });
  }
});

// ✅ Get user assets by assigned_to = user_id
router.get("/user-assets", async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) {
    return res.status(400).json({ error: "Missing user_id query parameter." });
  }

  try {
    console.log(`[DEBUG] Looking up assets for user_id: "${user_id}"`);
    const assets = await zendeskService.getUserAssets(user_id);
    console.log(`[DEBUG] Found ${assets.length} assets for user_id: ${user_id}`);
    res.json({ assets });
  } catch (error) {
    console.error("Error fetching user assets:", error.message);
    res.status(500).json({ error: "Failed to fetch user assets.", details: error.message });
  }
});

// 📦 Catalog route
router.get("/catalog", async (req, res) => {
  try {
    const catalog = await googleSheetsService.getCatalog();
    res.json(catalog);
  } catch (error) {
    console.error("Error fetching catalog:", error.message);
    res.status(500).json({ error: "Failed to fetch catalog from Google Sheets.", details: error.message });
  }
});

// 🆕 Create ticket with asset info
router.post("/ticket", verifyZendeskToken, async (req, res) => {
  try {
    const ticket = await zendeskService.createTicket(req.body);
    res.json({ ticket });
  } catch (error) {
    console.error("Error creating ticket:", error.message);
    res.status(500).json({ error: "Failed to create ticket." });
  }
});

// ✏️ Update a specific asset
router.patch("/assets/:id", async (req, res) => {
  try {
    const updated = await zendeskService.updateAsset(req.params.id, req.body);
    res.json(updated);
  } catch (error) {
    console.error("Error updating asset:", error.message);
    res.status(500).json({ error: "Failed to update asset." });
  }
});

// ➕ Create new asset
router.post("/assets", async (req, res) => {
  try {
    const result = await zendeskService.createAsset(req.body);
    res.status(201).json(result);
  } catch (error) {
    console.error('Error creating asset:', error.message);
    res.status(500).json({ error: 'Failed to create asset.', details: error.message });
  }
});

module.exports = router;
