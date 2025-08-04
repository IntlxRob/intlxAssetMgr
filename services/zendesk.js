// src/services/zendesk.js
const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN     = process.env.ZENDESK_TOKEN;

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const CUSTOM_OBJECT_KEY = 'asset';

// 🛡️ Auth Header
const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${auth}`,
  'Content-Type': 'application/json',
};

// 🔍 Search users by name or email
async function searchUsers(query) {
  if (!query) return [];
  const res = await axios.get(
    `${BASE_URL}/users/search.json?query=${encodeURIComponent(query)}`,
    { headers }
  );
  return res.data.users || [];
}

// 👤 Get a single user by ID
async function getUserById(userId) {
  const res = await axios.get(
    `${BASE_URL}/users/${userId}.json`,
    { headers }
  );
  return res.data.user || null;
}

// 🏢 List all organizations
async function getOrganizations() {
  const res = await axios.get(
    `${BASE_URL}/organizations.json`,
    { headers }
  );
  return res.data.organizations || [];
}

// 🏷️ Get one org by ID
async function getOrganizationById(orgId) {
  const res = await axios.get(
    `${BASE_URL}/organizations/${orgId}.json`,
    { headers }
  );
  return res.data.organization || null;
}

// 📦 Get all custom-object asset records
async function getAllAssets() {
  const res = await axios.get(
    `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
    { headers }
  );
  return res.data.custom_object_records || [];
}

// 🔍 Filter assets by assigned user ID
async function getUserAssetsById(userId) {
  const all = await getAllAssets();
  return all.filter(r =>
    String(r.custom_object_fields?.assigned_to) === String(userId)
  );
}

// ✏️ Update a single asset record
async function updateAsset(assetId, fields) {
  const res = await axios.patch(
    `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records/${assetId}.json`,
    { attributes: fields },
    { headers }
  );
  return res.data;
}

// ➕ Create a new asset record
async function createAsset(data) {
  const res = await axios.post(
    `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
    { record: { attributes: data } },
    { headers }
  );
  return res.data;
}

// 📐 Fetch the asset schema (to read field definitions/options)
async function getAssetFields() {
  const res = await axios.get(
    `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/schema.json`,
    { headers }
  );
  return res.data.fields || [];
}

// 🎫 Create a new Zendesk ticket
async function createTicket(ticketData) {
  const res = await axios.post(
    `${BASE_URL}/tickets.json`,
    { ticket: ticketData },
    { headers }
  );
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
