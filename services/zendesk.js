const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN     = process.env.ZENDESK_API_TOKEN;

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const CUSTOM_OBJECT_KEY = 'asset';

// 🛡️ Auth Header
const authHeader = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${authHeader}`,
  'Content-Type': 'application/json',
};

// 🔍 Search users by name/email
async function searchUsers(query) {
  if (!query) return [];
  const url = `${BASE_URL}/users/search.json?query=${encodeURIComponent(query)}`;
  try {
    const res = await axios.get(url, { headers });
    return res.data.users || [];
  } catch (err) {
    console.error('[zendesk.searchUsers] ', err.response?.status, err.message);
    return [];
  }
}

// 🔍 Get a single user by ID
async function getUserById(userId) {
  try {
    const res = await axios.get(`${BASE_URL}/users/${userId}.json`, { headers });
    return res.data.user || null;
  } catch (err) {
    console.error('[zendesk.getUserById] ', err.response?.status, err.message);
    return null;
  }
}

// 🏢 List all organizations
async function getOrganizations() {
  try {
    const res = await axios.get(`${BASE_URL}/organizations.json`, { headers });
    return res.data.organizations || [];
  } catch (err) {
    console.error('[zendesk.getOrganizations] ', err.response?.status, err.message);
    return [];
  }
}

// 🏢 Get a single organization by ID
async function getOrganizationById(orgId) {
  try {
    const res = await axios.get(`${BASE_URL}/organizations/${orgId}.json`, { headers });
    return res.data.organization || null;
  } catch (err) {
    console.error('[zendesk.getOrganizationById] ', err.response?.status, err.message);
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
    // some APIs return `data` or `custom_object_records`
    return res.data.data || res.data.custom_object_records || [];
  } catch (err) {
    console.error('[zendesk.getAllAssets] ', err.response?.status, err.message);
    return [];
  }
}

// 🔍 Filter assets by assigned_to = userId
async function getUserAssetsById(userId) {
  try {
    const all = await getAllAssets();
    return all.filter((rec) =>
      String(rec.custom_object_fields?.assigned_to) === String(userId)
    );
  } catch (err) {
    console.error('[zendesk.getUserAssetsById] ', err.message);
    return [];
  }
}

// ✏️ Create a new asset record
async function createAsset(fields) {
  try {
    const res = await axios.post(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
      { record: { attributes: fields } },
      { headers }
    );
    return res.data;
  } catch (err) {
    console.error('[zendesk.createAsset] ', err.response?.status, err.message);
    throw err;
  }
}

// ✏️ Update an existing asset record
async function updateAsset(assetId, fields) {
  try {
    const res = await axios.patch(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records/${assetId}.json`,
      { attributes: fields },
      { headers }
    );
    return res.data;
  } catch (err) {
    console.error('[zendesk.updateAsset] ', err.response?.status, err.message);
    throw err;
  }
}

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
    console.error('[zendesk.createTicket] ', err.response?.status, err.message);
    throw err;
  }
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
  createAsset,
  updateAsset,

  // tickets
  createTicket,
};
