// src/services/zendesk.js

const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN     = process.env.ZENDESK_API_TOKEN;

const BASE_URL  = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const ASSET_KEY = 'asset';

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
  } catch {
    return [];
  }
}

/**
 * Get a single user by ID
 */
async function getUserById(id) {
  try {
    const res = await axios.get(`${BASE_URL}/users/${id}.json`, { headers });
    return res.data.user;
  } catch {
    return null;
  }
}

/**
 * Get all Zendesk organizations.
 */
async function getOrganizations() {
  try {
    const res = await axios.get(`${BASE_URL}/organizations.json`, { headers });
    return res.data.organizations || [];
  } catch {
    return [];
  }
}

/**
 * Get a single organization by ID
 */
async function getOrganizationById(id) {
  try {
    const res = await axios.get(`${BASE_URL}/organizations/${id}.json`, { headers });
    return res.data.organization;
  } catch {
    return null;
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
    return res.data.custom_object_records || [];
  } catch {
    return [];
  }
}

/**
 * Filter assets by assigned_to user ID.
 */
async function getUserAssetsById(userId) {
  try {
    const all = await getAllAssets();
    return all.filter(r =>
      String(r.custom_object_fields?.assigned_to) === String(userId)
    );
  } catch {
    return [];
  }
}

/**
 * Update a specific asset record.
 */
async function updateAsset(assetId, updatedFields) {
  const res = await axios.patch(
    `${BASE_URL}/custom_objects/${ASSET_KEY}/records/${assetId}.json`,
    { attributes: updatedFields },
    { headers }
  );
  return res.data;
}

/**
 * Create a new asset record.
 */
async function createAsset(assetData) {
  const res = await axios.post(
    `${BASE_URL}/custom_objects/${ASSET_KEY}/records.json`,
    { record: { attributes: assetData } },
    { headers }
  );
  return res.data;
}

/**
 * Fetch the schema for custom object (e.g. to get enum options for status).
 */
async function getAssetFields() {
  const res = await axios.get(
    `${BASE_URL}/custom_objects/${ASSET_KEY}/fields.json`,
    { headers }
  );
  return res.data.custom_object_fields || [];
}

/**
 * Create a Zendesk ticket.
 */
async function createTicket(ticketData) {
  const res = await axios.post(
    `${BASE_URL}/tickets.json`,
    { ticket: ticketData },
    { headers }
  );
  return res.data.ticket;
}

module.exports = {
  // user lookups
  searchUsers,
  getUserById,

  // organization lookups
  getOrganizations,
  getOrganizationById,

  // asset CRUD + schema
  getAllAssets,
  getUserAssetsById,
  updateAsset,
  createAsset,
  getAssetFields,

  // tickets
  createTicket,
};
