// services/zendesk.js
const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const ASSET_KEY = 'asset';

const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${auth}`,
  'Content-Type': 'application/json',
};

// ————————————————————————————————————————————————
// 1) Get the current authenticated user (for health-check)
async function getCurrentUser() {
  const res = await axios.get(`${BASE_URL}/users/me.json`, { headers });
  return res.data.user;
}

// 2) Look up a single user by ID
async function getUserById(userId) {
  const res = await axios.get(`${BASE_URL}/users/${userId}.json`, { headers });
  return res.data.user;
}

// 3) Look up a single organization by ID
async function getOrganizationById(orgId) {
  const res = await axios.get(`${BASE_URL}/organizations/${orgId}.json`, { headers });
  return res.data.organization;
}

// 4) Fetch all custom_object asset records (raw)
async function getAllAssets() {
  const res = await axios.get(
    `${BASE_URL}/custom_objects/${ASSET_KEY}/records.json`,
    { headers }
  );
  return res.data.custom_object_records || [];
}

// 5) Fetch only those assets assigned to a given user ID
async function getUserAssetsById(userId) {
  const all = await getAllAssets();
  return all.filter(r => String(r.custom_object_fields.assigned_to) === String(userId));
}

// 6) Fetch the asset‐object “definition” so you can render your dropdowns (e.g. status)
async function getAssetSchema() {
  const res = await axios.get(
    `${BASE_URL}/custom_objects/${ASSET_KEY}/definition.json`,
    { headers }
  );
  // the JSON will include an array of field definitions under `res.data.custom_object_definition`
  return res.data.custom_object_definition;
}

// 7) Create a new asset record
async function createAsset(fields) {
  const res = await axios.post(
    `${BASE_URL}/custom_objects/${ASSET_KEY}/records`,
    { record: { attributes: fields } },
    { headers }
  );
  return res.data;
}

// 8) Update an existing asset record
async function updateAsset(recordId, updatedFields) {
  const res = await axios.patch(
    `${BASE_URL}/custom_objects/${ASSET_KEY}/records/${recordId}`,
    { attributes: updatedFields },
    { headers }
  );
  return res.data;
}

// 9) (Optional) Create a Zendesk support ticket
async function createTicket(ticketData) {
  const res = await axios.post(
    `${BASE_URL}/tickets.json`,
    { ticket: ticketData },
    { headers }
  );
  return res.data.ticket;
}

module.exports = {
  getCurrentUser,
  getUserById,
  getOrganizationById,
  getAllAssets,
  getUserAssetsById,
  getAssetSchema,
  createAsset,
  updateAsset,
  createTicket,
};
