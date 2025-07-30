const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN = process.env.ZENDESK_API_TOKEN; // ✅ Corrected variable name

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const CUSTOM_OBJECT_KEY = 'asset';

// 🛡️ Auth Header
const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${auth}`,
  'Content-Type': 'application/json',
};

// 🔍 Search for users by name
async function searchUsers(name) {
  if (!name) return [];
  try {
    const response = await axios.get(`${BASE_URL}/users/search.json?query=${encodeURIComponent(name)}`, {
      headers,
    });
    return response.data.users || [];
  } catch (error) {
    console.error('[searchUsers] Error:', error.response?.status, error.message);
    return [];
  }
}

// 🏢 Get all organizations
async function getOrganizations() {
  try {
    const response = await axios.get(`${BASE_URL}/organizations`, { headers });
    return response.data.organizations || [];
  } catch (error) {
    console.error('[getOrganizations] Error:', error.response?.status, error.message);
    return [];
  }
}

// 📦 Get all asset records
async function getAllAssets() {
  try {
    const response = await axios.get(`${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records`, {
      headers,
    });
    return response.data.custom_object_records || []; // ✅ Corrected response key
  } catch (error) {
    console.error('[getAllAssets] Error:', error.response?.status, error.message);
    return [];
  }
}

// 🔍 Filter assets by assigned user ID
async function getUserAssetsById(userId) {
  console.debug(`[DEBUG] Filtering assets by user_id: ${userId}`);
  try {
    const allAssets = await getAllAssets();
    const filtered = allAssets.filter((asset) => {
      const assignedTo = asset.custom_object_fields?.assigned_to;
      return String(assignedTo) === String(userId);
    });
    console.debug(`[DEBUG] Matched ${filtered.length} assets for user_id: ${userId}`);
    return filtered;
  } catch (error) {
    console.error('[getUserAssetsById] Error:', error.message);
    return [];
  }
}

// ✏️ Update asset record
async function updateAsset(assetId, updatedFields) {
  try {
    const response = await axios.patch(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records/${assetId}`,
      { attributes: updatedFields },
      { headers }
    );
    return response.data;
  } catch (error) {
    console.error('[updateAsset] Error:', error.response?.status, error.message);
    throw error;
  }
}

// ➕ Create a new asset record
async function createAsset(assetData) {
  try {
    const response = await axios.post(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records`,
      { record: { attributes: assetData } },
      { headers }
    );
    return response.data;
  } catch (error) {
    console.error('[createAsset] Error:', error.response?.status, error.response?.data || error.message);
    throw error;
  }
}

// 🎫 Create a Zendesk ticket
async function createTicket(ticketData) {
  try {
    const response = await axios.post(
      `${BASE_URL}/tickets`,
      { ticket: ticketData },
      { headers }
    );
    return response.data.ticket;
  } catch (error) {
    console.error('[createTicket] Error:', error.response?.status, error.response?.data || error.message);
    throw error;
  }
}

module.exports = {
  searchUsers,
  getOrganizations,
  getAllAssets,
  getUserAssetsById,
  updateAsset,
  createAsset,
  createTicket,
};
