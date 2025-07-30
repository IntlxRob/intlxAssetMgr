const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN = process.env.ZENDESK_API_TOKEN; // ✅ corrected var name

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const CUSTOM_OBJECT_KEY = 'asset'; // customize if needed

// 🛡️ Auth Header
const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${auth}`,
  'Content-Type': 'application/json',
};

// 🔍 Search Users
async function searchUsers(name) {
  if (!name) return [];
  try {
    const res = await axios.get(`${BASE_URL}/users/search.json?query=${encodeURIComponent(name)}`, { headers });
    return res.data.users || [];
  } catch (error) {
    console.error('[searchUsers] Failed:', error.response?.status);
    return [];
  }
}

// 🏢 Get Organizations
async function getOrganizations() {
  try {
    const res = await axios.get(`${BASE_URL}/organizations`, { headers });
    return res.data.organizations || [];
  } catch (error) {
    console.error('[getOrganizations] Failed:', error.response?.status);
    return [];
  }
}

// 📦 Get All Assets
async function getAllAssets() {
  try {
    const res = await axios.get(`${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records`, { headers });
    return res.data?.data || [];
  } catch (error) {
    console.error('[getAllAssets] Failed:', error.response?.status);
    return [];
  }
}

// 🧩 Get Assets Assigned to a User ID
async function getUserAssetsById(userId) {
  console.debug(`[DEBUG] Filtering assets by user_id: ${userId}`);
  try {
    const allAssets = await getAllAssets();
    return allAssets.filter((asset) => {
      const assignedTo = asset.custom_object_fields?.assigned_to;
      return String(assignedTo) === String(userId);
    });
  } catch (error) {
    console.error('[getUserAssetsById] Failed:', error.message);
    return [];
  }
}

// ✏️ Update Asset Record
async function updateAsset(assetId, updatedFields) {
  try {
    const res = await axios.patch(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records/${assetId}`,
      { attributes: updatedFields },
      { headers }
    );
    return res.data;
  } catch (error) {
    console.error('[updateAsset] Failed:', error.response?.status);
    throw error;
  }
}

// ➕ Create Asset Record
async function createAsset(assetData) {
  try {
    const res = await axios.post(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records`,
      { record: { attributes: assetData } },
      { headers }
    );
    return res.data;
  } catch (error) {
    console.error('[createAsset] Failed:', error.response?.status, error.response?.data);
    throw error;
  }
}

// 🎫 Create Zendesk Ticket
async function createTicket(ticketData) {
  try {
    const res = await axios.post(`${BASE_URL}/tickets`, { ticket: ticketData }, { headers });
    return res.data.ticket;
  } catch (error) {
    console.error('[createTicket] Failed:', error.response?.status, error.response?.data);
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
