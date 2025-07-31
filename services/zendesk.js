// services/zendesk.js
const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMA​IN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const CUSTOM_OBJECT_KEY = 'asset';

// 🛡️ Auth Header
const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${auth}`,
  'Content-Type':  'application/json'
};

/**
 * Search users by name or email
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
 * Lookup a single user by ID
 */
async function getUserById(id) {
  const res = await axios.get(`${BASE_URL}/users/${id}.json`, { headers });
  return res.data.user || null;
}

/**
 * List all organizations
 */
async function getOrganizations() {
  const res = await axios.get(`${BASE_URL}/organizations.json`, { headers });
  return res.data.organizations || [];
}

/**
 * Lookup a single organization by ID
 */
async function getOrganizationById(id) {
  const res = await axios.get(`${BASE_URL}/organizations/${id}.json`, { headers });
  return res.data.organization || null;
}

/**
 * Fetch the asset custom‐object schema (to pull out dropdown enums)
 */
async function getAssetSchema() {
  const res = await axios.get(
    `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/schema.json`,
    { headers }
  );
  return res.data.custom_object_schema || {};
}

/**
 * Fetch all asset records (paginated under the hood)
 */
async function getAllAssets(cursor = null, out = []) {
  const url = cursor
    ? `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json?page[cursor]=${cursor}`
    : `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`;

  const res = await axios.get(url, { headers });
  const batch = res.data.custom_object_records || [];
  const all  = out.concat(batch);

  return res.data.meta.has_more
    ? getAllAssets(res.data.meta.after_cursor, all)
    : all;
}

/**
 * Fetch assets filtered by assigned_to user ID
 */
async function getUserAssetsById(userId) {
  const all = await getAllAssets();
  return all.filter(r => String(r.custom_object_fields?.assigned_to) === String(userId));
}

/**
 * Create a brand‐new asset record
 */
async function createAsset(fields) {
  const payload = { record: { attributes: fields } };
  const res = await axios.post(
    `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
    payload,
    { headers }
  );
  return res.data;
}

/**
 * Update an existing asset record
 */
async function updateAsset(id, fields) {
  const payload = { attributes: fields };
  const res = await axios.patch(
    `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records/${id}.json`,
    payload,
    { headers }
  );
  return res.data;
}

// 🎫 Export all service methods
module.exports = {
  searchUsers,
  getUserById,
  getOrganizations,
  getOrganizationById,
  getAssetSchema,
  getAllAssets,
  getUserAssetsById,
  createAsset,
  updateAsset
};
