// src/services/zendesk.js
const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN     = process.env.ZENDESK_API_TOKEN;

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;

// 🛡️ Auth Header
const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${auth}`,
  'Content-Type': 'application/json',
};

// 🔍 Search users by name/email
async function searchUsers(query) {
  const q = encodeURIComponent(query || '');
  const res = await axios.get(`${BASE_URL}/users/search.json?query=${q}`, { headers });
  return res.data.users || [];
}

// 👤 Lookup a single user by ID
async function getUserById(id) {
  const res = await axios.get(`${BASE_URL}/users/${id}.json`, { headers });
  return res.data.user || null;
}

// 🏢 List all organizations
async function getOrganizations() {
  const res = await axios.get(`${BASE_URL}/organizations.json`, { headers });
  return res.data.organizations || [];
}

// 🏢 Lookup a single organization by ID
async function getOrganizationById(id) {
  const res = await axios.get(`${BASE_URL}/organizations/${id}.json`, { headers });
  return res.data.organization || null;
}

// 📦 Get all custom-object “asset” records
async function getAllAssets() {
  const res = await axios.get(`${BASE_URL}/custom_objects/asset/records.json`, { headers });
  return res.data.custom_object_records || [];
}

// 📦 Get only the records assigned to a given user ID
async function getUserAssetsById(userId) {
  const all = await getAllAssets();
  return all.filter(rec => String(rec.custom_object_fields?.assigned_to) === String(userId));
}

// ✏️ Update an asset record
async function updateAsset(assetId, updatedFields) {
  const payload = { attributes: updatedFields };
  const res = await axios.patch(
    `${BASE_URL}/custom_objects/asset/records/${assetId}.json`,
    payload,
    { headers }
  );
  return res.data;
}

// ➕ Create a new asset record
async function createAsset(assetData) {
  const res = await axios.post(
    `${BASE_URL}/custom_objects/asset/records.json`,
    { record: { attributes: assetData } },
    { headers }
  );
  return res.data;
}

// 🎫 Create a Zendesk ticket
async function createTicket(ticketData) {
  const res = await axios.post(
    `${BASE_URL}/tickets.json`,
    { ticket: ticketData },
    { headers }
  );
  return res.data.ticket;
}

module.exports = {
  // user lookups
  searchUsers,
  getUserById,

  // organization lookups
  getOrganizations,
  getOrganizationById,

  // asset CRUD
  getAllAssets,
  getUserAssetsById,
  updateAsset,
  createAsset,

  // tickets
  createTicket,
};
