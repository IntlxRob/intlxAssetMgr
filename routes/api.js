const express = require("express");
const router = express.Router();
const zendeskService = require("../services/zendesk");
const googleSheetsService = require("../services/googleSheets");
const verifyZendeskToken = require("../middleware/verifyZendeskToken");

// 🔍 Search for users
router.get("/users", async (req, res) => {
  const query = req.query.query || "";
  if (!query.trim()) {
    console.warn("[WARN] /users endpoint called with empty or missing query param");
    return res.json({ users: [] });
  }

  try {
    console.debug("[DEBUG] searchUsers() called with name:", `"${query}"`);
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
    res.json({ organizations: orgs });
  } catch (error) {
    console.error("Error fetching organizations:", error.message);
    res.status(500).json({ error: "Failed to fetch organizations." });
  }
});

// 💻 Get assets assigned to a user by user_id
router.get("/assets", async (req, res) => {
  const user_id = req.query.user_id;
  if (!user_id) {
    console.warn("[WARN] /assets endpoint called without user_id");
    return res.status(400).json({ error: "Missing 'user_id' parameter." });
  }

  try {
    console.debug("[DEBUG] Looking up assets for user_id:", `"${user_id}"`);
    const assets = await zendeskService.getUserAssetsById(user_id); // ✅ Corrected
    res.json({ assets });
  } catch (error) {
    console.error("Error fetching user assets:", error.message);
    res.status(500).json({ error: "Failed to fetch user assets." });
  }
});

module.exports = router;
