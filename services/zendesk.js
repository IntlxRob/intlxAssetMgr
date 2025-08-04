// services/zendesk.js
const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN     = process.env.ZENDESK_API_TOKEN;

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const CUSTOM_OBJECT_KEY = 'asset'; // your custom object key

// 🛡 Auth header
const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${auth}`,
  'Content-Type': 'application/json',
};

// 🔍 Search users
async function searchUsers(name) {
  if (!name) return [];
  const url = `${BASE_URL}/users/search.json?query=${encodeURIComponent(name)}`;
  const res = await axios.get(url, { headers });
  return res.data.users || [];
}

// 👤 Get single user
async function getUserById(id) {
  const url = `${BASE_URL}/users/${id}.json`;
  const res = await axios.get(url, { headers });
  return res.data.user;
}

// 🏢 List orgs
async function getOrganizations() {
  const url = `${BASE_URL}/organizations.json`;
  const res = await axios.get(url, { headers });
  return res.data.organizations || [];
}

// 🏷 Get single org
async function getOrganizationById(id) {
  const url = `${BASE_URL}/organizations/${id}.json`;
  const res = await axios.get(url, { headers });
  return res.data.organization;
}

// 📦 Get all assets (rarely used)
async function getAllAssets() {
  const url = `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`;
  const res = await axios.get(url, { headers });
  return res.data.custom_object_records || [];
}

// 🔍 Get only the assets assigned to a given user ID
async function getUserAssetsById(userId) {
  console.debug(`[zendesk.getUserAssetsById] Searching for assets assigned to user ID: ${userId}`);
  const url = `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records/search.json` +
              `?query=${encodeURIComponent(`assigned_to:${userId}`)}`;
  const res = await axios.get(url, { headers });
  console.debug('[zendesk.getUserAssetsById] Zendesk returned:', res.data);
  return res.data.custom_object_records || [];
}

// 🔧 Get the schema (to build your status dropdown)
async function getAssetFields() {
  console.debug('[zendesk.getAssetFields] Fetching asset schema fields...');
  // this endpoint is in v2/custom_objects/:key/schemas/:key.json
  const url = `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/schemas/${CUSTOM_OBJECT_KEY}.json`;
  const res = await axios.get(url, { headers });
  return res.data.schema.fields || [];
}

// ✏️ Update asset record
async function updateAsset(assetId, attributes) {
  const url = `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records/${assetId}`;
  const payload = { attributes };
  const res = await axios.patch(url, payload, { headers });
  return res.data;
}

// ➕ Create a new asset
async function createAsset(attributes) {
  const url = `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records`;
  const payload = { record: { attributes } };
  const res = await axios.post(url, payload, { headers });
  return res.data;
}

// 🎫 Create a Zendesk ticket
async function createTicket(ticketData) {
  const url = `${BASE_URL}/tickets.json`;
  const res = await axios.post(url, { ticket: ticketData }, { headers });
  return res.data.ticket;
}

module.exports = {
  // users
  searchUsers,
  getUserById,

  // orgs
  getOrganizations,
  getOrganizationById,

  // assets
  getAllAssets,
  getUserAssetsById,
  updateAsset,
  createAsset,
  getAssetFields,

  // tickets
  createTicket,
};
