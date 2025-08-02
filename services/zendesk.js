// src/services/zendesk.js
const axios = require('axios');

const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN     = process.env.ZENDESK_API_TOKEN;
const BASE_URL          = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const ASSET_KEY         = 'asset';

const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${auth}`,
  'Content-Type': 'application/json',
};

// — Users —

async function searchUsers(query) {
  const res = await axios.get(
    `${BASE_URL}/users/search.json?query=${encodeURIComponent(query)}`,
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
    `${BASE_URL}/custom_objects/${ASSET_KEY}/records.json`,
    { headers }
  );
  return res.data.custom_object_records || [];
}

async function getUserAssetsById(userId) {
  const all = await getAllAssets();
  return all.filter(r => String(r.custom_object_fields?.assigned_to) === String(userId));
}

async function updateAsset(assetId, attrs) {
  const res = await axios.patch(
    `${BASE_URL}/custom_objects/${ASSET_KEY}/records/${assetId}.json`,
    { record: { attributes: attrs } },
    { headers }
  );
  return res.data;
}

async function createAsset(data) {
  const res = await axios.post(
    `${BASE_URL}/custom_objects/${ASSET_KEY}/records.json`,
    { record: { attributes: data } },
    { headers }
  );
  return res.data;
}

// fetch field‐definitions (so we can pull out status options)
async function getAssetFields() {
  const res = await axios.get(
    `${BASE_URL}/custom_objects/${ASSET_KEY}/fields.json`,
    { headers }
  );
  return res.data.custom_object_fields || [];
}

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