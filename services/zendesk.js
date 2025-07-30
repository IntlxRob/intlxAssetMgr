// services/zendesk.js
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

// 🔍 Search Users by name or email
async function searchUsers(query) {
  if (!query || !query.trim()) return [];
  try {
    const res = await axios.get(
      `${BASE_URL}/users/search.json?query=${encodeURIComponent(query)}`,
      { headers }
    );
    return res.data.users || [];
  } catch (err) {
    console.error('[searchUsers] Error:', err.response?.status, err.message);
    return [];
  }
}

// 🏢 Get all Organizations
async function getOrganizations() {
  try {
    const res = await axios.get(
      `${BASE_URL}/organizations.json`,
      { headers }
    );
    return res.data.organizations || [];
  } catch (err) {
    console.error('[getOrganizations] Error:', err.response?.status, err.message);
    return [];
  }
}

// 🗂️ Fetch a single User by ID
async function getUserById(userId) {
  try {
    console.debug(`[getUserById] Fetching user ID: ${userId}`);
    const res = await axios.get(
      `${BASE_URL}/users/${userId}.json`,
      { headers }
    );
    return res.data.user;
  } catch (err) {
    console.error('[getUserById] Error:', err.response?.status, err.message);
    throw err;
  }
}

// 📦 Get All Assets (raw list)
async function getAllAssets() {
  try {
    const res = await axios.get(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
      { headers }
    );
    return res.data.data || [];
  } catch (err) {
    console.error('[getAllAssets] Error:', err.response?.status, err.message);
    return [];
  }
}

// 🧩 Get Assets assigned to a User ID via filtered search
async function getUserAssets(userId) {
  console.debug(`[getUserAssets] Searching assets for user: ${userId}`);
  try {
    const res = await axios.get(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records/search.json?query=assigned_to:${encodeURIComponent(userId)}`,
      { headers }
    );
    return res.data.data || [];
  } catch (err) {
    console.error('[getUserAssets] Error:', err.response?.status, err.message);
    throw err;
  }
}

// ✏️ Update Asset Record
async function updateAsset(assetId, updatedAttributes) {
  try {
    const res = await axios.patch(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records/${assetId}.json`,
      { record: { attributes: updatedAttributes } },
      { headers }
    );
    return res.data;
  } catch (err) {
    console.error('[updateAsset] Error:', err.response?.status, err.message);
    throw err;
  }
}

// ➕ Create a new Asset Record
async function createAsset(attributes) {
  try {
    const res = await axios.post(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
      { record: { attributes } },
      { headers }
    );
    return res.data;
  } catch (err) {
    console.error('[createAsset] Error:', err.response?.status, err.response?.data || err.message);
    throw err;
  }
}

// 🎫 Create a Zendesk Ticket
async function createTicket(ticketData) {
  try {
    const res = await axios.post(
      `${BASE_URL}/tickets.json`,
      { ticket: ticketData },
      { headers }
    );
    return res.data.ticket;
  } catch (err) {
    console.error('[createTicket] Error:', err.response?.status, err.response?.data || err.message);
    throw err;
  }
}

module.exports = {
  searchUsers,
  getOrganizations,
  getUserById,
  getAllAssets,
  getUserAssets,
  updateAsset,
  createAsset,
  createTicket,
};
