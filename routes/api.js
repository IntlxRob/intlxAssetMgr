const express = require("express");
const router = express.Router();
const zendeskService = require("../services/zendesk");
const googleSheetsService = require("../services/googleSheets");
const verifyZendeskToken = require("../middleware/verifyZendeskToken");

// 🔍 Search for users
router.get("/users", async (req, res) => {
  const query = req.query.query;
  if (!query) {
    console.warn("[WARN] /users endpoint called with empty or missing query param");
    return res.status(400).json({ error: "Missing query parameter." });
  }

  try {
    const users = await zendeskService.searchUsers(query);
    res.json({ users });
  } catch (error) {
    console.error("Error fetching users:", error.message);
    res.status(500).json({ error: "Failed to fetch users." });
  }
});

// 🏢 Get all organizations
router.get("/organizations", async (req, res) => {
  try {
    console.debug("[DEBUG] getOrganizations() called");
    const orgs = await zendeskService.getOrganizations();
    res.json(orgs);
  } catch (error) {
    console.error("Error fetching organizations:", error.message);
    res.status(500).json({ error: "Failed to fetch organizations." });
  }
});

// 👤 Get requester details by ID
router.get("/users/:id", async (req, res) => {
  const userId = req.params.id;
  if (!userId) {
    return res.status(400).json({ error: "Missing user ID." });
  }

  try {
    const user = await zendeskService.getUserById(userId);
    res.json({ user });
  } catch (error) {
    console.error("Error fetching user:", error.message);
    res.status(500).json({ error: "Failed to fetch user." });
  }
});

// 📦 Get assets assigned to user
router.get("/assets", async (req, res) => {
  const userId = req.query.user_id;
  if (!userId) {
    return res.status(400).json({ error: "Missing user_id parameter." });
  }

  try {
    const assets = await zendeskService.getAssetsByUserId(userId);
    res.json({ assets });
  } catch (error) {
    console.error("Error fetching assets:", error.message);
    res.status(500).json({ error: "Failed to fetch assets." });
  }
});

module.exports = router;
