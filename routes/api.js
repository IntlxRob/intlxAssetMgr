const express = require("express");
const router = express.Router();
const axios = require("axios");
const zendeskService = require("../services/zendesk");
const googleSheetsService = require("../services/googleSheets");
const verifyZendeskToken = require("../middleware/verifyZendeskToken");

// 🔐 Zendesk Auth Setup
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN = process.env.ZENDESK_API_TOKEN; // ✅ Corrected
const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;

const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${auth}`,
  'Content-Type': 'application/json',
};

// 🔐 Auth Check - confirms Zendesk token works
router.get("/auth-check", async (req, res) => {
  console.debug("[DEBUG] /auth-check called");
  console.debug("[DEBUG] Auth header:", headers.Authorization);

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

// 🔍 Search for users
router.get("/users", async (req, res) => {
  const query = req.query.query?.trim();
  if (!query) {
    console.warn("[WARN] /users endpoint called with empty or missing query param");
    return res.status(400).json({ error: "Missing or empty 'query' parameter." });
  }

  try {
    const users = await zendeskService.searchUsers(query);
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

// ✅ Get user assets by assigned_to = user_name
router.get("/user-assets", async (req, res) => {
  const { user_name } = req.query;
  if (!user_name) {
    return res.status(400).json({ error: "Missing user_name query parameter." });
  }

  try {
    console.log(`[DEBUG] Requested user_name: "${user_name}"`);

    const assets = await zendeskService.getAllAssets();
    const normalizedName = user_name.trim().toLowerCase();

    const matchedAssets = assets.filter((record) => {
      const assignedTo = record.custom_object_fields?.assigned_to?.trim().toLowerCase();
      const isMatch = assignedTo === normalizedName;
      console.log(`[DEBUG] Checking asset "${record.id}" → assigned_to: "${assignedTo}" → match: ${isMatch}`);
      return isMatch;
    });

    console.log(`[DEBUG] Matched ${matchedAssets.length} assets for: "${user_name}"`);
    res.json({ assets: matchedAssets });
  } catch (error) {
    console.error("Error fetching user assets:", error.message);
    res.status(500).json({ error: "Failed to fetch user assets.", details: error.message });
  }
});

// 🧾 Get all assets
router.get("/assets", async (req, res) => {
  try {
    const assets = await zendeskService.getAllAssets();
    res.json({ assets });
  } catch (error) {
    console.error("Error fetching assets:", error.message);
    res.status(500).json({ error: "Failed to fetch assets." });
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

// 🆕 Create a ticket with asset request info
router.post("/ticket", verifyZendeskToken, async (req, res) => {
  try {
    const ticket = await zendeskService.createTicket(req.body);
    res.json({ ticket });
  } catch (error) {
    console.error("Error creating ticket:", error.message);
    res.status(500).json({ error: "Failed to create ticket." });
  }
});

// 📦 Catalog route for loading from Google Sheets
router.get("/catalog", async (req, res) => {
  try {
    const catalog = await googleSheetsService.getCatalog();
    res.json(catalog);
  } catch (error) {
    console.error("Error fetching catalog:", error.message);
    res.status(500).json({ error: "Failed to fetch catalog from Google Sheets.", details: error.message });
  }
});

module.exports = router;
