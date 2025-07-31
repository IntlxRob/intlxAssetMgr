// routes/api.js
const express = require("express");
const router = express.Router();
const zendeskService       = require("../services/zendesk");
const googleSheetsService  = require("../services/googleSheets"); // if you still need it
const verifyZendeskToken   = require("../middleware/verifyZendeskToken"); // optional, only on write routes

/**
 * Search users by free‐text query.
 * GET /api/users?query=Bob
 */
router.get("/users", async (req, res) => {
  const q = (req.query.query || "").trim();
  if (!q) {
    return res.json({ users: [] });
  }
  try {
    const users = await zendeskService.searchUsers(q);
    res.json({ users });
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).json({ error: "Failed to fetch users." });
  }
});

/**
 * Fetch exactly one user by ID.
 * GET /api/users/:id
 */
router.get("/users/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const user = await zendeskService.getUserById(id);
    if (!user) return res.status(404).json({ error: "User not found." });
    res.json({ user });
  } catch (err) {
    console.error(`Error fetching user ${id}:`, err);
    res.status(500).json({ error: "Failed to fetch user." });
  }
});

/**
 * List all organizations.
 * GET /api/organizations
 */
router.get("/organizations", async (req, res) => {
  try {
    const orgs = await zendeskService.getOrganizations();
    res.json({ organizations: orgs });
  } catch (err) {
    console.error("Error fetching organizations:", err);
    res.status(500).json({ error: "Failed to fetch organizations." });
  }
});

/**
 * Fetch one organization by ID.
 * GET /api/organizations/:id
 */
router.get("/organizations/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const org = await zendeskService.getOrganizationById(id);
    if (!org) return res.status(404).json({ error: "Organization not found." });
    res.json({ organization: org });
  } catch (err) {
    console.error(`Error fetching organization ${id}:`, err);
    res.status(500).json({ error: "Failed to fetch organization." });
  }
});

/**
 * List all asset records assigned to a given user.
 * GET /api/assets?user_id=12345
 */
router.get("/assets", async (req, res) => {
  const userId = req.query.user_id;
  if (!userId) {
    return res.status(400).json({ error: "Missing 'user_id' parameter." });
  }
  try {
    const assets = await zendeskService.getUserAssetsById(userId);
    res.json({ assets });
  } catch (err) {
    console.error("Error fetching user assets:", err);
    res.status(500).json({ error: "Failed to fetch user assets." });
  }
});

/**
 * Update a single asset record.
 * PATCH /api/assets/:id
 */
router.patch("/assets/:id", /* verifyZendeskToken, */ async (req, res) => {
  const id = req.params.id;
  const updates = req.body;
  try {
    const updated = await zendeskService.updateAsset(id, updates);
    res.json(updated);
  } catch (err) {
    console.error(`Error updating asset ${id}:`, err);
    res.status(500).json({ error: "Failed to update asset." });
  }
});

/**
 * Return the Custom Object definition for "asset", including
 * field enumerations (e.g. your status dropdown list).
 * GET /api/asset-definition
 */
router.get("/asset-definition", async (req, res) => {
  try {
    const def = await zendeskService.getObjectDefinition("asset");
    res.json(def);
  } catch (err) {
    console.error("Error fetching asset definition:", err);
    res.status(500).json({ error: "Definition lookup failed." });
  }
});

module.exports = router;
