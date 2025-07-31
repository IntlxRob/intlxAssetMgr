const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN     = process.env.ZENDESK_API_TOKEN;

const BASE_URL  = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const ASSET_KEY  = 'asset';

// 🛡️ Auth Header
const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${auth}`,
  'Content-Type': 'application/json',
};

// — User lookups —

// Search users by name/email
async function searchUsers(query) {
  if (!query) return [];
  try {
    const res = await axios.get(
      `${BASE_URL}/users/search.json?query=${encodeURIComponent(query)}`,
      { headers }
    );
    return res.data.users || [];
  } catch (err) {
    console.error('[searchUsers] Failed:', err.response?.status);
    return [];
  }
}

// Get a single user by ID
async function getUserById(userId) {
  if (!userId) return null;
  try {
    const res = await axios.get(
      `${BASE_URL}/users/${userId}.json`,
      { headers }
    );
    return res.data.user;
  } catch (err) {
    console.error('[getUserById] Failed:', err.response?.status);
    return null;
  }
}
const searchUserById = getUserById;

// — Organization lookups —

// List all organizations
async function getOrganizations() {
  try {
    const res = await axios.get(
      `${BASE_URL}/organizations.json`,
      { headers }
    );
    return res.data.organizations || [];
  } catch (err) {
    console.error('[getOrganizations] Failed:', err.response?.status);
    return [];
  }
}

// Get one organization by ID
async function getOrganizationById(orgId) {
  if (!orgId) return null;
  try {
    const res = await axios.get(
      `${BASE_URL}/organizations/${orgId}.json`,
      { headers }
    );
    return res.data.organization;
  } catch (err) {
    console.error('[getOrganizationById] Failed:', err.response?.status);
    return null;
  }
}

// — Asset CRUD —

// Fetch all asset records
async function getAllAssets() {
  try {
    const res = await axios.get(
      `${BASE_URL}/custom_objects/${ASSET_KEY}/records`,
      { headers }
    );
    return res.data.data || [];
  } catch (err) {
    console.error('[getAllAssets] Failed:', err.response?.status);
    return [];
  }
}

// Fetch assets assigned to a user
async function getUserAssetsById(userId) {
  try {
    const all = await getAllAssets();
    return all.filter(r =>
      String(r.custom_object_fields?.assigned_to) === String(userId)
    );
  } catch (err) {
    console.error('[getUserAssetsById] Failed:', err.message);
    return [];
  }
}

// Fetch the “asset” custom-object definition (including its fields)
async function getAssetSchema() {
  // 1) list all definitions
  const listRes = await axios.get(
    `${BASE_URL}/custom_object_definitions`,
    { headers }
  );
  const def = listRes.data.custom_object_definitions
    .find(d =>
      d.object_type === ASSET_KEY ||
      d.title.toLowerCase() === ASSET_KEY
    );
  if (!def) throw new Error(`Definition for "${ASSET_KEY}" not found`);

  // 2) fetch full details
  const full = await axios.get(
    `${BASE_URL}/custom_object_definitions/${def.id}`,
    { headers }
  );
  return full.data.custom_object_definition;
}

// Update a single asset record
async function updateAsset(assetId, attributes) {
  try {
    const res = await axios.patch(
      `${BASE_URL}/custom_objects/${ASSET_KEY}/records/${assetId}`,
      { attributes },
      { headers }
    );
    return res.data;
  } catch (err) {
    console.error('[updateAsset] Failed:', err.response?.status, err.response?.data);
    throw err;
  }
}

// Create a new asset record
async function createAsset(data) {
  try {
    const res = await axios.post(
      `${BASE_URL}/custom_objects/${ASSET_KEY}/records`,
      { record: { attributes: data } },
      { headers }
    );
    return res.data;
  } catch (err) {
    console.error('[createAsset] Failed:', err.response?.status, err.response?.data);
    throw err;
  }
}

// — Ticket creation —

// Create a Zendesk ticket
async function createTicket(ticketData) {
  try {
    const res = await axios.post(
      `${BASE_URL}/tickets`,
      { ticket: ticketData },
      { headers }
    );
    return res.data.ticket;
  } catch (err) {
    console.error('[createTicket] Failed:', err.response?.status, err.response?.data);
    throw err;
  }
}

module.exports = {
  // user lookups
  searchUsers,
  getUserById,
  searchUserById,

  // organization lookups
  getOrganizations,
  getOrganizationById,

  // asset CRUD
  getAllAssets,
  getUserAssetsById,
  getAssetSchema,
  updateAsset,
  createAsset,

  // tickets
  createTicket,
};
