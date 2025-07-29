const express = require("express");
const router = express.Router();
const zendeskService = require("../services/zendesk");
const googleSheetsService = require("../services/googleSheets");
const verifyZendeskToken = require("../middleware/verifyZendeskToken");

// 🔍 Search for users
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

// ✅ Get user assets by assigned_to = user_name
router.get("/user-assets", async (req, res) => {
  const { user_name } = req.query;
  if (!user_name) {
    return res.status(400).json({ error: "Missing user_name query parameter." });
  }

  try {
    const assets = await zendeskService.getUserAssetsByName(user_name);
    res.json({ assets });
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
