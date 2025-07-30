const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN = process.env.ZENDESK_API_TOKEN;

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const CUSTOM_OBJECT_KEY = 'asset';

// 🛡️ Auth Header
const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${auth}`,
  'Content-Type': 'application/json',
};

// 🔍 Get a single user by ID
async function getUserById(userId) {
  try {
    const res = await axios.get(
      `${BASE_URL}/users/${userId}.json`,
      { headers }
    );
    return res.data.user;
  } catch (error) {
    console.error('[getUserById] Failed:', error.response?.status, error.message);
    throw error;
  }
}

// 🔍 Search for users by name or email
async function searchUsers(query) {
  if (!query) return [];
  try {
    const res = await axios.get(
      `${BASE_URL}/users/search.json?query=${encodeURIComponent(query)}`,
      { headers }
    );
    return res.data.users || [];
  } catch (error) {
    console.error('[searchUsers] Failed:', error.response?.status, error.message);
    return [];
  }
}

// 🏢 Get all organizations
async function getOrganizations() {
  try {
    const res = await axios.get(
      `${BASE_URL}/organizations.json`,
      { headers }
    );
    return res.data.organizations || [];
  } catch (error) {
    console.error('[getOrganizations] Failed:', error.response?.status, error.message);
    return [];
  }
}

// 📦 Get all asset records (unfiltered)
async function getAllAssets() {
  try {
    const res = await axios.get(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
      { headers }
    );
    return res.data.data || [];
  } catch (error) {
    console.error('[getAllAssets] Failed:', error.response?.status, error.message);
    return [];
  }
}

// 🧩 Filter assets by assigned user ID using filtered search
async function getUserAssetsById(userId) {
  try {
    const payload = {
      filter: {
        conditions: [
          { field: 'assigned_to', operator: 'is', value: String(userId) }
        ]
      }
    };
    const res = await axios.post(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records/search.json`,
      payload,
      { headers }
    );
    return res.data.results || [];
  } catch (error) {
    console.error('[getUserAssetsById] Failed:', error.response?.status, error.message);
    return [];
  }
}

// ✏️ Update an asset record
async function updateAsset(assetId, updatedFields) {
  try {
    const res = await axios.patch(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records/${assetId}.json`,
      { attributes: updatedFields },
      { headers }
    );
    return res.data;
  } catch (error) {
    console.error('[updateAsset] Failed:', error.response?.status, error.message);
    throw error;
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
  } catch (error) {
    console.error('[createAsset] Failed:', error.response?.status, error.message);
    throw error;
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
  } catch (error) {
    console.error('[createTicket] Failed:', error.response?.status, error.message);
    throw error;
  }
}

module.exports = {
  getUserById,
  searchUsers,
  getOrganizations,
  getAllAssets,
  getUserAssetsById,
  updateAsset,
  createAsset,
  createTicket,
};
