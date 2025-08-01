// src/services/zendesk.js

const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN     = process.env.ZENDESK_API_TOKEN; // or process.env.ZENDESK_API_TOKEN

const BASE_URL  = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const ASSET_KEY = 'asset';  // your custom object key

// 🛡️ Auth Header
const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${auth}`,
  'Content-Type': 'application/json',
};

/**
 * Search Zendesk users by name or email.
 */
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

/**
 * Get all Zendesk organizations.
 */
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

/**
 * Get all records of the custom object.
 */
async function getAllAssets() {
  try {
    const res = await axios.get(
      `${BASE_URL}/custom_objects/${ASSET_KEY}/records.json`,
      { headers }
    );
    // adjust this key if your API returns a different one
    return res.data.custom_object_records || [];
  } catch (err) {
    console.error('[getAllAssets] Failed:', err.response?.status);
    return [];
  }
}

/**
 * Filter those assets by assigned_to user ID.
 */
async function getUserAssetsById(userId) {
  try {
    const all = await getAllAssets();
    return all.filter(r =>
      String(r.custom_object_fields?.assigned_to) === String(userId)
    );
  } catch (err) {
    console.error('[getUserAssetsById] Failed:', err.message);
    return [];
  }
}

/**
 * Patch a specific asset record.
 */
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

/**
 * Create a new asset record.
 */
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

/**
 * Fetch the fields (schema) for that custom object,
 * including enum options for dropdowns like `status`.
 */
async function getAssetFields() {
  try {
    const res = await axios.get(
      `${BASE_URL}/custom_objects/${ASSET_KEY}/fields.json`,
      { headers }
    );
    return res.data.custom_object_fields || [];
  } catch (err) {
    console.error('[getAssetFields] Failed:', err.response?.status, err.response?.data);
    throw err;
  }
}

/**
 * Create a Zendesk ticket.
 */
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

  // organization lookups
  getOrganizations,

  // asset CRUD
  getAllAssets,
  getUserAssetsById,
  updateAsset,
  createAsset,
  getAssetFields,

  // tickets
  createTicket,
};
