// routes/api.js
const express = require("express");
const router  = express.Router();
const zendesk = require("../services/zendesk");

// 🔍 Search for users by name (already existed)
router.get("/users", async (req, res) => {
  const query = req.query.query || "";
  if (!query.trim()) return res.json({ users: [] });
  try {
    const users = await zendesk.searchUsers(query);
    res.json({ users });
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).json({ error: "Failed to fetch users." });
  }
});

// ➡️ Get a single user by ID
router.get("/users/:id", async (req, res) => {
  try {
    const user = await zendesk.getUserById(req.params.id);
    res.json({ user });
  } catch (err) {
    console.error(`[GET /users/${req.params.id}]`, err);
    res.status(500).json({ error: "Failed to fetch user." });
  }
});

// 🏢 List all organizations (already existed)
router.get("/organizations", async (req, res) => {
  try {
    const orgs = await zendesk.getOrganizations();
    res.json({ organizations: orgs });
  } catch (err) {
    console.error("Error fetching organizations:", err);
    res.status(500).json({ error: "Failed to fetch organizations." });
  }
});

// ➡️ Get a single organization by ID
router.get("/organizations/:id", async (req, res) => {
  try {
    const organization = await zendesk.getOrganizationById(req.params.id);
    res.json({ organization });
  } catch (err) {
    console.error(`[GET /organizations/${req.params.id}]`, err);
    res.status(500).json({ error: "Failed to fetch organization." });
  }
});

// 📦 List assets assigned to a user
router.get("/assets", async (req, res) => {
  const user_id = req.query.user_id;
  if (!user_id) {
    return res.status(400).json({ error: "Missing 'user_id' parameter." });
  }
  try {
    const assets = await zendesk.getUserAssetsById(user_id);
    res.json({ assets });
  } catch (err) {
    console.error("Error fetching assets:", err);
    res.status(500).json({ error: "Failed to fetch assets." });
  }
});

// ✏️ Update an asset
router.patch("/assets/:id", async (req, res) => {
  try {
    const updated = await zendesk.updateAsset(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    console.error(`[PATCH /assets/${req.params.id}]`, err);
    res.status(500).json({ error: "Failed to update asset." });
  }
});

// 🔧 Expose your custom‐object schema so the front end can build the Status dropdown
router.get("/asset-definition", async (req, res) => {
  try {
    const def = await zendesk.getAssetDefinition();
    res.json({ custom_object_definition: def });
  } catch (err) {
    console.error("Error fetching asset definition:", err);
    res.status(500).json({ error: "Failed to fetch asset definition." });
  }
});

module.exports = router;
