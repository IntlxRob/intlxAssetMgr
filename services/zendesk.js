// services/zendesk.js
const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const CUSTOM_OBJECT_KEY = 'asset'; // your custom object key

// 🛡️ Auth Header
const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${auth}`,
  'Content-Type':  'application/json',
};

// 🔍 Search users by free-text query
async function searchUsers(query) {
  if (!query) return [];
  try {
    const res = await axios.get(
      `${BASE_URL}/users/search.json?query=${encodeURIComponent(query)}`,
      { headers }
    );
    return res.data.users || [];
  } catch (err) {
    console.error('[searchUsers] ', err.response?.status, err.message);
    return [];
  }
}

// 👤 Get a single user by ID
async function getUserById(id) {
  try {
    const res = await axios.get(
      `${BASE_URL}/users/${id}.json`,
      { headers }
    );
    return res.data.user || null;
  } catch (err) {
    console.error(`[getUserById] ${id} →`, err.response?.status, err.message);
    return null;
  }
}

// 🏢 List all organizations
async function getOrganizations() {
  try {
    const res = await axios.get(
      `${BASE_URL}/organizations.json`,
      { headers }
    );
    return res.data.organizations || [];
  } catch (err) {
    console.error('[getOrganizations] ', err.response?.status, err.message);
    return [];
  }
}

// 🏢 Get one organization by ID
async function getOrganizationById(id) {
  try {
    const res = await axios.get(
      `${BASE_URL}/organizations/${id}.json`,
      { headers }
    );
    return res.data.organization || null;
  } catch (err) {
    console.error(`[getOrganizationById] ${id} →`, err.response?.status, err.message);
    return null;
  }
}

// 📦 Fetch all asset records
async function getAllAssets() {
  try {
    const res = await axios.get(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
      { headers }
    );
    return res.data.custom_object_records || [];
  } catch (err) {
    console.error('[getAllAssets] ', err.response?.status, err.message);
    return [];
  }
}

// 🔍 Filter assets by assigned_to user ID
async function getUserAssetsById(userId) {
  try {
    const all = await getAllAssets();
    return all.filter(record => 
      String(record.custom_object_fields.assigned_to) === String(userId)
    );
  } catch (err) {
    console.error('[getUserAssetsById] ', err.message);
    return [];
  }
}

// ✏️ Update a custom object record
async function updateAsset(assetId, updatedFields) {
  try {
    const res = await axios.patch(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records/${assetId}.json`,
      { record: { attributes: updatedFields } },
      { headers }
    );
    return res.data;
  } catch (err) {
    console.error(`[updateAsset] ${assetId} →`, err.response?.status, err.message);
    throw err;
  }
}

// ➕ Create a new asset record
async function createAsset(assetData) {
  try {
    const res = await axios.post(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
      { record: { attributes: assetData } },
      { headers }
    );
    return res.data;
  } catch (err) {
    console.error('[createAsset] ', err.response?.status, err.message);
    throw err;
  }
}

// 🎫 Create a Zendesk Support ticket
async function createTicket(ticketData) {
  try {
    const res = await axios.post(
      `${BASE_URL}/tickets.json`,
      { ticket: ticketData },
      { headers }
    );
    return res.data.ticket;
  } catch (err) {
    console.error('[createTicket] ', err.response?.status, err.message);
    throw err;
  }
}

// 🗂️ Fetch the custom object definition (for dropdowns, enums, etc.)
async function getObjectDefinition(objectKey = CUSTOM_OBJECT_KEY) {
  try {
    const res = await axios.get(
      `${BASE_URL}/custom_objects/${objectKey}/definition.json`,
      { headers }
    );
    return res.data.custom_object_definition;
  } catch (err) {
    console.error(`[getObjectDefinition] ${objectKey} →`, err.response?.status, err.message);
    return null;
  }
}

module.exports = {
  searchUsers,
  getUserById,
  getOrganizations,
  getOrganizationById,
  getAllAssets,
  getUserAssetsById,
  updateAsset,
  createAsset,
  createTicket,
  getObjectDefinition,
};
