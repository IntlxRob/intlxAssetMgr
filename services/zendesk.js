// services/zendesk.js

const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN     = process.env.ZENDESK_API_TOKEN; // or ZENDESK_API_TOKEN

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const CUSTOM_OBJECT_KEY = 'asset'; // your custom object key

// Auth header for all requests
const authHeader = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${authHeader}`,
  'Content-Type':  'application/json',
};

/**
 * Quick health-check for your Zendesk credentials
 */
async function testConnection() {
  const res = await axios.get(`${BASE_URL}/users/me.json`, { headers });
  return res.data.user;
}

/**
 * Search users by name/email fragment
 * GET /api/users?query=...
 */
async function searchUsers(query) {
  if (!query) return [];
  const res = await axios.get(
    `${BASE_URL}/users/search.json?query=${encodeURIComponent(query)}`,
    { headers }
  );
  return res.data.users || [];
}

/**
 * Fetch a single user by Zendesk user ID
 * GET /api/users/:id
 */
async function getUserById(userId) {
  const res = await axios.get(`${BASE_URL}/users/${userId}.json`, { headers });
  return res.data.user;
}

/**
 * List all organizations
 * GET /api/organizations
 */
async function getOrganizations() {
  const res = await axios.get(`${BASE_URL}/organizations.json`, { headers });
  return res.data.organizations || [];
}

/**
 * Fetch a single organization by Zendesk org ID
 * GET /api/organizations/:id
 */
async function getOrganizationById(orgId) {
  const res = await axios.get(`${BASE_URL}/organizations/${orgId}.json`, { headers });
  return res.data.organization;
}

/**
 * List all custom-object asset records
 * GET /api/custom_objects/asset/records.json
 */
async function getAllAssets() {
  const res = await axios.get(
    `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
    { headers }
  );
  // some API variants use data.custom_object_records vs data.data
  return res.data.custom_object_records || res.data.data || [];
}

/**
 * Filter assets assigned to a given user ID
 * GET /api/assets?user_id=...
 */
async function getUserAssetsById(userId) {
  const all = await getAllAssets();
  return all.filter(record => {
    const assigned = record.custom_object_fields?.assigned_to;
    return String(assigned) === String(userId);
  });
}

/**
 * Update a custom-object asset record
 * PATCH /api/custom_objects/asset/records/{id}.json
 */
async function updateAsset(assetId, updatedFields) {
  const payload = { attributes: updatedFields };
  const res = await axios.patch(
    `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records/${assetId}.json`,
    payload,
    { headers }
  );
  return res.data;
}

/**
 * Create a new asset record
 * POST /api/custom_objects/asset/records.json
 */
async function createAsset(assetData) {
  const payload = { record: { attributes: assetData } };
  const res = await axios.post(
    `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
    payload,
    { headers }
  );
  return res.data;
}

/**
 * Create a new Zendesk ticket
 * POST /api/tickets.json
 */
async function createTicket(ticketData) {
  const res = await axios.post(
    `${BASE_URL}/tickets.json`,
    { ticket: ticketData },
    { headers }
  );
  return res.data.ticket;
}

module.exports = {
  // health
  testConnection,

  // users/orgs
  searchUsers,
  getUserById,
  getOrganizations,
  getOrganizationById,

  // assets
  getAllAssets,
  getUserAssetsById,
  createAsset,
  updateAsset,

  // tickets
  createTicket,
};
