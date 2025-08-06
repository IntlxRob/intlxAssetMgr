// services/zendesk.js
const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN     = process.env.ZENDESK_API_TOKEN;

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`; //
const CUSTOM_OBJECT_KEY = 'asset'; //

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
  const searchQuery = `name:"${query}"* type:user`;
  const res = await zendeskApi.get(`/search.json?query=${encodeURIComponent(searchQuery)}`);
  return res.data.results || [];
}

// 👤 Get one user by ID
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

// 📦 Get assets assigned to a particular Zendesk user ID
//    Fetches all pages of assets and filters locally. This is the required method
//    because the 'assigned_to' field is a 'Lookup' type and not searchable via the API.
// 🏢 Search organizations by name
async function searchOrganizations(query) {
  if (!query) return [];
  const searchQuery = `name:"${query}"* type:organization`;
  const res = await zendeskApi.get(`/search.json?query=${encodeURIComponent(searchQuery)}`);
  return res.data.results || [];
}

// 📦 Get assets assigned to a particular Zendesk user ID
async function getUserAssetsById(userId) {
  console.log(`[DEBUG] Fetching all assets to filter for user ID: ${userId}`);
  try {
    let allRecords = [];
    let nextPage = `/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`;

    // Loop through all pages until there are no more records
    while (nextPage) {
      console.log(`[DEBUG] Fetching page: ${nextPage}`);
      const response = await zendeskApi.get(nextPage);
      const records = response.data.custom_object_records || [];
      allRecords.push(...records);
      
      // Check if there is another page of results
      nextPage = response.data.meta.has_more ? response.data.links.next : null;
    }

    console.log(`[DEBUG] Fetched a total of ${allRecords.length} assets across all pages.`);

    // Filter the complete list of records locally
    const userAssets = allRecords.filter(
      (record) => String(record.custom_object_fields?.assigned_to) === String(userId)
    );

    console.log(`[DEBUG] Found ${userAssets.length} assets assigned to user ID ${userId} after filtering.`);
    const userAssets = allRecords.filter(
      (record) => String(record.custom_object_fields?.assigned_to) === String(userId)
    );
    
    return userAssets;

  } catch (err) {
    console.error('[DEBUG] Error fetching all user assets:', err.response ? err.response.data : err.message);
    throw err;
  }
}

// 🔧 Update an asset’s attributes
async function updateAsset(assetId, attrs) {
  const payload = {
    custom_object_record: { custom_fields: attrs }
  };
  const res = await zendeskApi.patch(
    `/custom_objects/${CUSTOM_OBJECT_KEY}/records/${assetId}.json`,
    payload
  );
  return res.data;
}

// ➕ Create a new asset record
async function createAsset(attrs) {
  const payload = {
    custom_object_record: { custom_fields: attrs }
  };
  const res = await zendeskApi.post(
    `/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
    payload
  );
  return res.data;
}

// 🔍 Get the schema (fields + options) for your asset custom object
async function getAssetFields() {
  try {
    console.log('[DEBUG] Fetching asset schema fields...');
    // Uses the corrected path without '/metadata/'
    const res = await zendeskApi.get(
      `/custom_objects/${CUSTOM_OBJECT_KEY}/fields.json`
    );
    console.log('[DEBUG] Successfully received asset schema from Zendesk API.');
// 🔍 Get the schema for your asset custom object
async function getAssetFields() {
  try {
    const res = await zendeskApi.get(
      `/custom_objects/${CUSTOM_OBJECT_KEY}/fields.json`
    );
    return res.data.custom_object_fields || [];
  } catch(err) {
    console.error('[DEBUG] Error fetching asset schema from Zendesk API:', err.response ? err.response.data : err.message);
    throw err;
  }
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
  getUserAssetsById,
  updateAsset,
  createAsset,
  getAssetFields,

  // tickets
  createTicket,
}; //