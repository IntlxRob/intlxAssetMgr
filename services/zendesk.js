// services/zendesk.js

const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN     = process.env.ZENDESK_TOKEN; // or ZENDESK_API_TOKEN

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const ASSET_KEY = 'asset'; // your custom object key

// 🛡️ Auth Header
const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${auth}`,
  'Content-Type': 'application/json',
};

// — User lookups —

// 🔍 Search users by name or email
async function searchUsers(query) {
  if (!query) return [];
  try {
    const res = await axios.get(
      `${BASE_URL}/users/search.json?query=${encodeURIComponent(query)}`,
      { headers }
    );
    return res.data.users || [];
  } catch (err) {
    console.error('[searchUsers] Failed:', err.response?.status);
    return [];
  }
}

// 🔍 Get single user by ID
async function getUserById(userId) {
  try {
    const res = await axios.get(
      `${BASE_URL}/users/${userId}.json`,
      { headers }
    );
    return res.data.user || null;
  } catch (err) {
    console.error('[getUserById] Failed:', err.response?.status);
    return null;
  }
}

// alias for clarity if you need it
const searchUserById = getUserById;

// — Organization lookups —

// 🏢 List all organizations
async function getOrganizations() {
  try {
    const res = await axios.get(
      `${BASE_URL}/organizations.json`,
      { headers }
    );
    return res.data.organizations || [];
  } catch (err) {
    console.error('[getOrganizations] Failed:', err.response?.status);
    return [];
  }
}

// 🏢 Get single organization by ID
async function getOrganizationById(orgId) {
  try {
    const res = await axios.get(
      `${BASE_URL}/organizations/${orgId}.json`,
      { headers }
    );
    return res.data.organization || null;
  } catch (err) {
    console.error('[getOrganizationById] Failed:', err.response?.status);
    return null;
  }
}

// — Asset CRUD —

// 📦 Fetch all asset records
async function getAllAssets() {
  try {
    const res = await axios.get(
      `${BASE_URL}/custom_objects/${ASSET_KEY}/records.json`,
      { headers }
    );
    return res.data.custom_object_records || [];
  } catch (err) {
    console.error('[getAllAssets] Failed:', err.response?.status);
    return [];
  }
}

// 🧩 Fetch assets assigned to a specific user ID
async function getUserAssetsById(userId) {
  try {
    const all = await getAllAssets();
    return all.filter(rec =>
      String(rec.custom_object_fields?.assigned_to) === String(userId)
    );
  } catch (err) {
    console.error('[getUserAssetsById] Failed:', err.message);
    return [];
  }
}

// 🏗️ Get the schema/definition for the asset custom object
async function getAssetSchema() {
  try {
    const listRes = await axios.get(
      `${BASE_URL}/custom_object_definitions.json`,
      { headers }
    );
    const def = listRes.data.custom_object_definitions.find(d =>
      d.object_type === ASSET_KEY || d.title.toLowerCase() === ASSET_KEY
    );
    if (!def) throw new Error(`Definition for "${ASSET_KEY}" not found`);
    const defRes = await axios.get(
      `${BASE_URL}/custom_object_definitions/${def.id}.json`,
      { headers }
    );
    return defRes.data.custom_object_definition;
  } catch (err) {
    console.error('[getAssetSchema] Failed:', err.response?.status, err.response?.data);
    throw err;
  }
}

// 🛠️ Fetch all field definitions (to get dropdown options, etc.)
async function getAssetFields() {
  try {
    const res = await axios.get(
      `${BASE_URL}/custom_objects/${ASSET_KEY}/fields.json`,
      { headers }
    );
    return res.data.custom_object_fields || [];
  } catch (err) {
    console.error('[getAssetFields] Failed:', err.response?.status, err.response?.data);
    return [];
  }
}

// ✏️ Update a custom‐object record
async function updateAsset(assetId, updatedFields) {
  try {
    const res = await axios.patch(
      `${BASE_URL}/custom_objects/${ASSET_KEY}/records/${assetId}.json`,
      { attributes: updatedFields },
      { headers }
    );
    return res.data;
  } catch (err) {
    console.error('[updateAsset] Failed:', err.response?.status, err.response?.data);
    throw err;
  }
}

// ➕ Create a new custom‐object record
async function createAsset(assetData) {
  try {
    const res = await axios.post(
      `${BASE_URL}/custom_objects/${ASSET_KEY}/records.json`,
      { record: { attributes: assetData } },
      { headers }
    );
    return res.data;
  } catch (err) {
    console.error('[createAsset] Failed:', err.response?.status, err.response?.data);
    throw err;
  }
}

// — Tickets —

// 🎫 Create a Zendesk ticket
async function createTicket(ticketData) {
  try {
    const res = await axios.post(
      `${BASE_URL}/tickets.json`,
      { ticket: ticketData },
      { headers }
    );
    return res.data.ticket;
  } catch (err) {
    console.error('[createTicket] Failed:', err.response?.status, err.response?.data);
    throw err;
  }
}

module.exports = {
  // user lookups
  searchUsers,
  getUserById,
  searchUserById,

  // organization lookups
  getOrganizations,
  getOrganizationById,

  // asset CRUD
  getAllAssets,
  getUserAssetsById,
  getAssetSchema,
  getAssetFields,
  updateAsset,
  createAsset,

  // tickets
  createTicket,
};
