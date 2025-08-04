// services/zendesk.js
const axios = require('axios');

// 🔐 Env
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN     = process.env.ZENDESK_API_TOKEN;

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const CUSTOM_OBJECT_KEY = 'asset';

// Auth header
const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${auth}`,
  'Content-Type': 'application/json',
};

// — Users —
async function searchUsers(name) {
  if (!name) return [];
  const res = await axios.get(
    `${BASE_URL}/users/search.json?query=${encodeURIComponent(name)}`,
    { headers }
  );
  return res.data.users || [];
}

async function getUserById(id) {
  const res = await axios.get(`${BASE_URL}/users/${id}.json`, { headers });
  return res.data.user || null;
}

// — Organizations —
async function getOrganizations() {
  const res = await axios.get(`${BASE_URL}/organizations.json`, { headers });
  return res.data.organizations || [];
}

async function getOrganizationById(id) {
  const res = await axios.get(`${BASE_URL}/organizations/${id}.json`, { headers });
  return res.data.organization || null;
}

// — Assets —
async function getAllAssets() {
  const res = await axios.get(
    `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
    { headers }
  );
  // depending on your API version it may be under `data` or `custom_object_records`
  return res.data.data || res.data.custom_object_records || [];
}

async function getUserAssetsById(userId) {
  const all = await getAllAssets();
  return all.filter(r =>
    String(r.custom_object_fields?.assigned_to) === String(userId)
  );
}

async function updateAsset(id, fields) {
  const res = await axios.patch(
    `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records/${id}`,
    { attributes: fields },
    { headers }
  );
  return res.data;
}

async function createAsset(assetData) {
  const res = await axios.post(
    `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
    { record: { attributes: assetData } },
    { headers }
  );
  return res.data;
}

/**
 * 🏷️ getAssetFields
 * Fetches the custom‐object metadata for “asset”, including
 * its field definitions and any `custom_field_options`
 * (used to populate your Status dropdown).
 */
async function getAssetFields() {
  const res = await axios.get(
    `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/metadata/fields.json?include=custom_field_options`,
    { headers }
  );
  // returns array of field definitions
  return res.data.fields || res.data.custom_object_fields || [];
}

// — Tickets —
async function createTicket(ticketData) {
  const res = await axios.post(
    `${BASE_URL}/tickets.json`,
    { ticket: ticketData },
    { headers }
  );
  return res.data.ticket;
}

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
  updateAsset,
  createAsset,
  getAssetFields,

  // tickets
  createTicket,
};
