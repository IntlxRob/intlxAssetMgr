// services/zendesk.js
const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN     = process.env.ZENDESK_API_TOKEN;
const BASE_URL          = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const CUSTOM_OBJECT_KEY = 'asset';

const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${auth}`,
  'Content-Type':  'application/json',
};

// 🔍 Search users by name
async function searchUsers(name) {
  if (!name) return [];
  const res = await axios.get(
    `${BASE_URL}/users/search.json?query=${encodeURIComponent(name)}`,
    { headers }
  );
  return res.data.users || [];
}

// 👤 Fetch a single user by ID
async function getUserById(userId) {
  const res = await axios.get(`${BASE_URL}/users/${userId}.json`, { headers });
  return res.data.user;
}

// 🏢 Fetch all organizations
async function getOrganizations() {
  const res = await axios.get(`${BASE_URL}/organizations.json`, { headers });
  return res.data.organizations || [];
}

// 🏢 Fetch a single organization by ID
async function getOrganizationById(orgId) {
  const res = await axios.get(`${BASE_URL}/organizations/${orgId}.json`, { headers });
  return res.data.organization;
}

// 📦 Get all custom-object “asset” records
async function getAllAssets() {
  const res = await axios.get(
    `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
    { headers }
  );
  return res.data.custom_object_records || [];
}

// 🧩 Filter assets by assigned_to user ID
async function getUserAssetsById(userId) {
  const all = await getAllAssets();
  return all.filter(record =>
    String(record.custom_object_fields.assigned_to) === String(userId)
  );
}

// 📑 Fetch the asset custom-object schema (for enum/drop-down definitions)
async function getAssetSchema() {
  const res = await axios.get(
    `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/schema.json`,
    { headers }
  );
  return res.data.custom_object_schema;
}

// ✏️ Update a single asset record
async function updateAsset(assetId, fields) {
  const payload = { record: { attributes: fields } };
  const res = await axios.patch(
    `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records/${assetId}.json`,
    payload,
    { headers }
  );
  return res.data;
}

module.exports = {
  searchUsers,
  getUserById,
  getOrganizations,
  getOrganizationById,
  getAllAssets,
  getUserAssetsById,
  getAssetSchema,
  updateAsset,
};
