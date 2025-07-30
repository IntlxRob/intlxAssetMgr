// routes/api.js

const express = require("express");
const router = express.Router();
const zendeskService = require("../services/zendesk");
const verifyZendeskToken = require("../middleware/verifyZendeskToken");

// ✅ GET specific user by ID
router.get("/users/:id", async (req, res) => {
  const userId = req.params.id;
  try {
    const user = await zendeskService.getUserById(userId);
    res.json({ user });
  } catch (error) {
    console.error("Error fetching user:", error.message);
    res.status(500).json({ error: "Failed to fetch user." });
  }
});

// 🔍 Search users
router.get("/users", async (req, res) => {
  const query = req.query.query || "";
  if (!query.trim()) {
    console.warn("/users endpoint called with empty or missing query param");
    return res.status(400).json({ error: "Missing query parameter" });
  }

  try {
    const users = await zendeskService.searchUsers(query);
    res.json({ users });
  } catch (error) {
    console.error("Error searching users:", error.message);
    res.status(500).json({ error: "Failed to search users." });
  }
});

// 🏢 Get all organizations
router.get("/organizations", async (req, res) => {
  try {
    const orgs = await zendeskService.getOrganizations();
    res.json({ organizations: orgs });
  } catch (error) {
    console.error("Error fetching organizations:", error.message);
    res.status(500).json({ error: "Failed to fetch organizations." });
  }
});

// 📦 Get user assets by user ID
router.get("/user-assets", async (req, res) => {
  const userId = req.query.user_id;
  if (!userId) {
    return res.status(400).json({ error: "Missing user_id parameter" });
  }

  try {
    const assets = await zendeskService.getUserAssets(userId);
    res.json({ assets });
  } catch (error) {
    console.error("Error fetching user assets:", error.message);
    res.status(500).json({ error: "Failed to fetch user assets." });
  }
});

module.exports = router;
