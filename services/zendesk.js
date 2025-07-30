const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN = process.env.ZENDESK_TOKEN;

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const CUSTOM_OBJECT_KEY = 'asset'; // defaulting to 'asset'

// 🛡️ Auth Header
const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${auth}`,
  'Content-Type': 'application/json',
};

// 🔍 Search Users
async function searchUsers(name) {
  console.debug(`[DEBUG] searchUsers() called with name: "${name}"`);
  if (!name) return [];
  try {
    const res = await axios.get(`${BASE_URL}/users/search.json?query=${encodeURIComponent(name)}`, { headers });
    return res.data.users || [];
  } catch (error) {
    console.error('searchUsers: Request failed', error.response?.status);
    return [];
  }
}

// 🏢 Get Organizations
async function getOrganizations() {
  console.debug('[DEBUG] getOrganizations() called');
  try {
    const res = await axios.get(`${BASE_URL}/organizations`, { headers });
    return res.data.organizations || [];
  } catch (error) {
    console.error('getOrganizations: Request failed', error.response?.status);
    return [];
  }
}

// 📦 Get All Assets
async function getAllAssets() {
  console.debug('[DEBUG] getAllAssets() called');
  try {
    const res = await axios.get(`${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records`, { headers });
    return res.data?.data || [];
  } catch (error) {
    console.error('getAllAssets: Request failed', error.response?.status);
    return [];
  }
}

// 🧩 Get User's Assets by Name
async function getUserAssetsByName(user_name) {
  console.debug(`[DEBUG] Requested user_name: "${user_name}"`);
  const allAssets = await getAllAssets();
  const userAssets = allAssets.filter(
    (asset) => asset.attributes?.assigned_to?.toLowerCase() === user_name.toLowerCase()
  );
  console.debug(`[DEBUG] Matched ${userAssets.length} assets for: "${user_name}"`);
  return userAssets;
}

// ✏️ Update Asset Record
async function updateAsset(assetId, updatedFields) {
  console.debug(`[DEBUG] updateAsset() called for ID: ${assetId}`);
  try {
    const res = await axios.patch(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records/${assetId}`,
      { attributes: updatedFields },
      { headers }
    );
    return res.data;
  } catch (error) {
    console.error('updateAsset: Request failed', error.response?.status);
    throw error;
  }
}

// 🎫 Create Zendesk Ticket
async function createTicket(ticketData) {
  console.debug('[DEBUG] createTicket() called');
  try {
    const res = await axios.post(`${BASE_URL}/tickets`, { ticket: ticketData }, { headers });
    return res.data.ticket;
  } catch (error) {
    console.error('createTicket: Request failed', error.response?.status, error.response?.data);
    throw error;
  }
}

// ✅ Export all
module.exports = {
  searchUsers,
  getOrganizations,
  getAllAssets,
  getUserAssetsByName,
  updateAsset,
  createTicket,
};
