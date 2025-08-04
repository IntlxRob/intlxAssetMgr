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
async function getUserAssetsById(userId) {
  console.log(`[DEBUG] Searching for assets assigned to user ID: ${userId}`);
  try {
    // This payload structure is required by the Zendesk API search endpoint
    const payload = {
      query: `assigned_to:${userId}`
    };

    // Use the POST search endpoint as required by Zendesk docs for filtering
    const res = await zendeskApi.post(
      `/custom_objects/${CUSTOM_OBJECT_KEY}/records/search.json`,
      payload
    );

    console.log('[DEBUG] Successfully received assets from Zendesk API search:', JSON.stringify(res.data, null, 2));
    return res.data.custom_object_records || [];
  } catch(err) {
    // The 422 error from previous logs confirmed the payload structure was the issue
    console.error('[DEBUG] Error searching for user assets from Zendesk API:', err.response ? err.response.data : err.message);
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
    return res.data.custom_object_fields || [];
  } catch(err) {
    // The 404 error from previous logs confirmed the path was wrong
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
  // The 'getAllAssets' function was removed as it is inefficient and not used by the final logic.
  getUserAssetsById,
  updateAsset,
  createAsset,
  getAssetFields,

  // tickets
  createTicket,
}; //