// routes/api.js

const express = require("express");
const router = express.Router();
const zendeskService = require("../services/zendesk");
const googleSheetsService = require("../services/googleSheets");
const verifyZendeskToken = require("../middleware/verifyZendeskToken");

/**
 * Health-check your Zendesk credentials
 */
router.get("/test-zendesk", async (req, res) => {
  try {
    const data = await zendeskService.testConnection();
    res.status(200).json({ success: true, message: "Connected to Zendesk", data });
  } catch (err) {
    console.error("[test-zendesk] Failed:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/users?query=foo
 * Search for users by name or email fragment
 */
router.get("/users", async (req, res) => {
  const q = (req.query.query || "").trim();
  if (!q) return res.json({ users: [] });

  try {
    const users = await zendeskService.searchUsers(q);
    res.json({ users });
  } catch (err) {
    console.error("[GET /api/users] Error:", err.message);
    res.status(500).json({ error: "Failed to fetch users." });
  }
});

/**
 * GET /api/users/:id
 * Fetch a single user by Zendesk ID
 */
router.get("/users/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const user = await zendeskService.getUserById(id);
    res.json({ user });
  } catch (err) {
    console.error(`[GET /api/users/${id}] Error:`, err.message);
    res.status(500).json({ error: "Failed to fetch user." });
  }
});

/**
 * GET /api/organizations
 * List all organizations
 */
router.get("/organizations", async (req, res) => {
  try {
    const organizations = await zendeskService.getOrganizations();
    res.json({ organizations });
  } catch (err) {
    console.error("[GET /api/organizations] Error:", err.message);
    res.status(500).json({ error: "Failed to fetch organizations." });
  }
});

/**
 * GET /api/organizations/:id
 * Fetch a single organization by Zendesk ID
 */
router.get("/organizations/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const organization = await zendeskService.getOrganizationById(id);
    res.json({ organization });
  } catch (err) {
    console.error(`[GET /api/organizations/${id}] Error:`, err.message);
    res.status(500).json({ error: "Failed to fetch organization." });
  }
});

/**
 * GET /api/assets?user_id=12345
 * Returns all asset records assigned to that user
 */
router.get("/assets", async (req, res) => {
  const userId = req.query.user_id;
  if (!userId) {
    return res.status(400).json({ error: "Missing 'user_id' query parameter." });
  }

  try {
    const assets = await zendeskService.getUserAssetsById(userId);
    res.json({ assets });
  } catch (err) {
    console.error("[GET /api/assets] Error:", err.message);
    res.status(500).json({ error: "Failed to fetch assets." });
  }
});

/**
 * PATCH /api/assets/:id
 * Update a custom-object asset record
 */
router.patch("/assets/:id", async (req, res) => {
  const assetId = req.params.id;
  const fieldsToUpdate = req.body;

  try {
    const updated = await zendeskService.updateAsset(assetId, fieldsToUpdate);
    res.json(updated);
  } catch (err) {
    console.error(`[PATCH /api/assets/${assetId}] Error:`, err.message);
    res.status(500).json({ error: "Failed to update asset." });
  }
});

/**
 * POST /api/ticket
 * Create a new Zendesk ticket (requires app JWT)
 */
router.post("/ticket", verifyZendeskToken, async (req, res) => {
  try {
    const ticket = await zendeskService.createTicket(req.body);
    res.status(201).json({ ticket });
  } catch (err) {
    console.error("[POST /api/ticket] Error:", err.message);
    res.status(500).json({ error: "Failed to create ticket." });
  }
});

/**
 * GET /api/catalog
 * Pull your service catalog from Google Sheets
 */
router.get("/catalog", async (req, res) => {
  try {
    const catalog = await googleSheetsService.getCatalog();
    res.json(catalog);
  } catch (err) {
    console.error("[GET /api/catalog] Error:", err.message);
    res.status(500).json({ error: "Failed to fetch catalog." });
  }
});

module.exports = router;
