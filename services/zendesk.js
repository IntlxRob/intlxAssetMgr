// src/services/zendesk.js
const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN     = process.env.ZENDESK_API_TOKEN;

// Your custom object key for assets
const KEY               = 'asset';

const BASE = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const auth = Buffer
  .from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`)
  .toString('base64');

const headers = {
  Authorization: `Basic ${auth}`,
  'Content-Type':  'application/json',
};

/** ─── USERS ────────────────────────────────────────────────────────────────── **/

/**
 * Search users by name or email.
 */
async function searchUsers(q) {
  if (!q) return [];
  const res = await axios.get(
    `${BASE}/users/search.json?query=${encodeURIComponent(q)}`,
    { headers }
  );
  return res.data.users || [];
}

/**
 * Get one user by ID.
 */
async function getUserById(id) {
  const res = await axios.get(`${BASE}/users/${id}.json`, { headers });
  return res.data.user;
}

/** ─── ORGANIZATIONS ───────────────────────────────────────────────────────── **/

/**
 * List all organizations.
 */
async function getOrganizations() {
  const res = await axios.get(`${BASE}/organizations.json`, { headers });
  return res.data.organizations || [];
}

/**
 * Get one organization by ID.
 */
async function getOrganizationById(id) {
  const res = await axios.get(`${BASE}/organizations/${id}.json`, { headers });
  return res.data.organization;
}

/** ─── ASSETS (CUSTOM OBJECT) ───────────────────────────────────────────────── **/

/**
 * Fetch all asset records.
 */
async function getAllAssets() {
  const res = await axios.get(
    `${BASE}/custom_objects/${KEY}/records.json`,
    { headers }
  );
  return res.data.custom_object_records || [];
}

/**
 * Search asset records where assigned_to = <userId>.
 */
async function getUserAssetsById(userId) {
  const query = `assigned_to:${userId}`;
  const res   = await axios.get(
    `${BASE}/custom_objects/${KEY}/records/search.json?query=${encodeURIComponent(query)}`,
    { headers }
  );
  return res.data.custom_object_records || [];
}

/**
 * Create a new asset record.
 */
async function createAsset(attributes) {
  const res = await axios.post(
    `${BASE}/custom_objects/${KEY}/records.json`,
    { record: { attributes } },
    { headers }
  );
  return res.data;
}

/**
 * Update a specific asset record’s attributes.
 */
async function updateAsset(id, attributes) {
  const res = await axios.patch(
    `${BASE}/custom_objects/${KEY}/records/${id}.json`,
    { attributes },
    { headers }
  );
  return res.data;
}

/**
 * Retrieve the asset schema (fields) for dropdowns, etc.
 */
async function getAssetFields() {
  const res = await axios.get(
    `${BASE}/custom_objects/${KEY}/schemas.json`,
    { headers }
  );
  const schemas = res.data.custom_object_schemas || [];
  const me      = schemas.find(s => s.key === KEY);
  return me ? me.fields : [];
}

/** ─── TICKETS ───────────────────────────────────────────────────────────────── **/

/**
 * Create a Zendesk ticket.
 */
async function createTicket(ticketPayload) {
  const res = await axios.post(
    `${BASE}/tickets.json`,
    { ticket: ticketPayload },
    { headers }
  );
  return res.data.ticket;
}

/** ─── EXPORTS ──────────────────────────────────────────────────────────────── **/

module.exports = {
  // users
  searchUsers,
  getUserById,

  // orgs
  getOrganizations,
  getOrganizationById,

  // assets
  getAllAssets,
  getUserAssetsById,
  createAsset,
  updateAsset,
  getAssetFields,

  // tickets
  createTicket,
};
