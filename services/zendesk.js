const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN     = process.env.ZENDESK_API_TOKEN;

const BASE_URL         = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const CUSTOM_OBJECT_KEY = 'asset';

// 🛡️ Auth Header
const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${auth}`,
  'Content-Type': 'application/json',
};

/**
 * Search for users by name or email
 */
async function searchUsers(query) {
  if (!query) return [];
  const url = `${BASE_URL}/users/search.json?query=${encodeURIComponent(query)}`;
  try {
    const res = await axios.get(url, { headers });
    return res.data.users || [];
  } catch (err) {
    console.error('[zendesk] searchUsers error', err.message);
    return [];
  }
}

/**
 * Get a single user by ID
 */
async function getUserById(userId) {
  try {
    const res = await axios.get(`${BASE_URL}/users/${userId}.json`, { headers });
    return res.data.user;
  } catch (err) {
    console.error(`[zendesk] getUserById(${userId}) error`, err.message);
    throw err;
  }
}

/**
 * Fetch all organizations
 */
async function getOrganizations() {
  try {
    const res = await axios.get(`${BASE_URL}/organizations.json`, { headers });
    return res.data.organizations || [];
  } catch (err) {
    console.error('[zendesk] getOrganizations error', err.message);
    return [];
  }
}

/**
 * Get a single organization by ID
 */
async function getOrganizationById(orgId) {
  try {
    const res = await axios.get(`${BASE_URL}/organizations/${orgId}.json`, { headers });
    return res.data.organization;
  } catch (err) {
    console.error(`[zendesk] getOrganizationById(${orgId}) error`, err.message);
    throw err;
  }
}

/**
 * Retrieve all asset records
 */
async function getAllAssets() {
  try {
    const res = await axios.get(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
      { headers }
    );
    return res.data.custom_object_records || [];
  } catch (err) {
    console.error('[zendesk] getAllAssets error', err.message);
    return [];
  }
}

/**
 * Filter assets assigned to a specific user ID
 */
async function getUserAssetsById(userId) {
  const all = await getAllAssets();
  return all.filter(record => String(record.custom_object_fields.assigned_to) === String(userId));
}

/**
 * Update an asset record by ID
 */
async function updateAsset(assetId, updatedFields) {
  try {
    const res = await axios.patch(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records/${assetId}.json`,
      { record: { attributes: updatedFields } },
      { headers }
    );
    return res.data;
  } catch (err) {
    console.error(`[zendesk] updateAsset(${assetId}) error`, err.message);
    throw err;
  }
}

/**
 * Create a new asset record
 */
async function createAsset(assetData) {
  try {
    const res = await axios.post(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
      { record: { attributes: assetData } },
      { headers }
    );
    return res.data;
  } catch (err) {
    console.error('[zendesk] createAsset error', err.message);
    throw err;
  }
}

/**
 * Create a standard Zendesk ticket
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
    console.error('[zendesk] createTicket error', err.message);
    throw err;
  }
}

/**
 * Fetch the custom‐object schema (to read status options, etc.)
 */
async function getAssetDefinition() {
  try {
    const res = await axios.get(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/schema.json`,
      { headers }
    );
    return res.data.custom_object_definition;
  } catch (err) {
    console.error('[zendesk] getAssetDefinition error', err.message);
    throw err;
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
  getAssetDefinition
};
