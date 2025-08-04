// services/zendesk.js
const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN     = process.env.ZENDESK_API_TOKEN;

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const CUSTOM_OBJECT_KEY = 'asset';

// 🛡️ Axios instance with basic auth
const zendeskApi = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `Basic ${Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64')}`,
    'Content-Type': 'application/json',
  },
});

// 🔍 Search users by name/email
async function searchUsers(query) {
  if (!query) return [];
  const res = await zendeskApi.get(`/users/search.json?query=${encodeURIComponent(query)}`);
  return res.data.users || [];
}

// 👤 Get one user by ID (includes organization_id)
async function getUserById(id) {
  const res = await zendeskApi.get(`/users/${id}.json`);
  return res.data.user;
}

// 🏢 List all organizations
async function getOrganizations() {
  const res = await zendeskApi.get(`/organizations.json`);
  return res.data.organizations || [];
}

// 🏢 Get one organization by ID
async function getOrganizationById(id) {
  const res = await zendeskApi.get(`/organizations/${id}.json`);
  return res.data.organization;
}

// 📦 Get all asset records
async function getAllAssets() {
  const res = await zendeskApi.get(`/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`);
  // res.data.custom_object_records on newer APIs
  return res.data.custom_object_records || res.data.data || [];
}

// 📦 Get assets assigned to a particular Zendesk user ID
async function getUserAssetsById(userId) {
  const all = await getAllAssets();
  return all.filter(record => String(record.custom_object_fields?.assigned_to) === String(userId));
}

// 🔧 Update an asset’s attributes
async function updateAsset(assetId, attrs) {
  const res = await zendeskApi.patch(
    `/custom_objects/${CUSTOM_OBJECT_KEY}/records/${assetId}.json`,
    { attributes: attrs }
  );
  return res.data;
}

// ➕ Create a new asset record
async function createAsset(attrs) {
  const res = await zendeskApi.post(
    `/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
    { record: { attributes: attrs } }
  );
  return res.data;
}

// 🔍 Get the schema (fields + options) for your asset custom object
async function getAssetFields() {
  const res = await zendeskApi.get(
    `/custom_objects/${CUSTOM_OBJECT_KEY}/metadata/fields.json`
  );
  return res.data.fields || [];
}

// 🎫 Create a Zendesk ticket
async function createTicket(ticketData) {
  const res = await zendeskApi.post(`/tickets.json`, { ticket: ticketData });
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
