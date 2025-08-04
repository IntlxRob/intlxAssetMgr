// services/zendesk.js
const axios = require('axios');

// 🔐 Env
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN     = process.env.ZENDESK_API_TOKEN;

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const KEY      = 'asset'; // your custom object key

// Auth header
const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const headers = { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' };

// — USERS —
// search by name/email
async function searchUsers(name) {
  if (!name) return [];
  const res = await axios.get(
    `${BASE_URL}/users/search.json?query=${encodeURIComponent(name)}`,
    { headers }
  );
  return res.data.users || [];
}

// get single user
async function getUserById(id) {
  const res = await axios.get(`${BASE_URL}/users/${id}.json`, { headers });
  return res.data.user;
}

// — ORGS —
// list all
async function getOrganizations() {
  const res = await axios.get(`${BASE_URL}/organizations.json`, { headers });
  return res.data.organizations || [];
}

// single by ID
async function getOrganizationById(id) {
  const res = await axios.get(`${BASE_URL}/organizations/${id}.json`, { headers });
  return res.data.organization;
}

// — ASSETS —
// list all records (not normally used)
async function getAllAssets() {
  const res = await axios.get(
    `${BASE_URL}/custom_objects/${KEY}/records.json`,
    { headers }
  );
  return res.data.custom_object_records || [];
}

// search by assigned_to:<userId>
async function getUserAssetsById(userId) {
  console.debug(`[zendesk] getUserAssetsById → userId=${userId}`);
  const res = await axios.get(
    `${BASE_URL}/custom_objects/${KEY}/records/search.json?` +
    `query=${encodeURIComponent(`assigned_to:${userId}`)}`,
    { headers }
  );
  console.debug('[zendesk] assets search returned', res.data);
  return res.data.custom_object_records || [];
}

// fetch the schema list, then pick out our KEY
async function getAssetFields() {
  console.debug('[zendesk] getAssetFields → fetching schemas list');
  const res = await axios.get(
    `${BASE_URL}/custom_objects/${KEY}/schemas.json`,
    { headers }
  );
  const schemas = res.data.custom_object_schemas || [];
  const me = schemas.find(s => s.key === KEY);
  if (!me) {
    console.warn(`[zendesk] no schema with key="${KEY}" found`);
    return [];
  }
  return me.fields || [];
}

// update a record
async function updateAsset(assetId, attributes) {
  const res = await axios.patch(
    `${BASE_URL}/custom_objects/${KEY}/records/${assetId}`,
    { attributes },
    { headers }
  );
  return res.data;
}

// create a record
async function createAsset(attributes) {
  const res = await axios.post(
    `${BASE_URL}/custom_objects/${KEY}/records`,
    { record: { attributes } },
    { headers }
  );
  return res.data;
}

// tickets
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
