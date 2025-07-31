const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN     = process.env.ZENDESK_API_TOKEN;

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const ASSET_KEY = 'asset'; // your custom object key

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
  const url = `${BASE_URL}/users/search.json?query=${encodeURIComponent(query)}`;
  try {
    const r = await axios.get(url, { headers });
    return r.data.users || [];
  } catch (e) {
    console.error('[searchUsers]', e.response?.status);
    return [];
  }
}

// Get user by ID
async function getUserById(id) {
  if (!id) return null;
  const url = `${BASE_URL}/users/${id}.json`;
  try {
    const r = await axios.get(url, { headers });
    return r.data.user;
  } catch (e) {
    console.error('[getUserById]', e.response?.status);
    return null;
  }
}
const searchUserById = getUserById;

// — Organization lookups —

async function getOrganizations() {
  const url = `${BASE_URL}/organizations.json`;
  try {
    const r = await axios.get(url, { headers });
    return r.data.organizations || [];
  } catch (e) {
    console.error('[getOrganizations]', e.response?.status);
    return [];
  }
}

async function getOrganizationById(id) {
  if (!id) return null;
  const url = `${BASE_URL}/organizations/${id}.json`;
  try {
    const r = await axios.get(url, { headers });
    return r.data.organization;
  } catch (e) {
    console.error('[getOrganizationById]', e.response?.status);
    return null;
  }
}

// — Asset CRUD —

async function getAllAssets() {
  const url = `${BASE_URL}/custom_objects/${ASSET_KEY}/records.json`;
  try {
    const r = await axios.get(url, { headers });
    // in v2 it returns under `data`
    return r.data.data || [];
  } catch (e) {
    console.error('[getAllAssets]', e.response?.status);
    return [];
  }
}

async function getUserAssetsById(userId) {
  try {
    const all = await getAllAssets();
    return all.filter(r =>
      String(r.custom_object_fields?.assigned_to) === String(userId)
    );
  } catch (e) {
    console.error('[getUserAssetsById]', e);
    return [];
  }
}

// Fetch entire list of custom‐object definitions
async function getAssetSchema() {
  // 1) list definitions
  const listUrl = `${BASE_URL}/custom_object_definitions.json`;
  const listRes = await axios.get(listUrl, { headers });
  const def = listRes.data.custom_object_definitions.find(d =>
    d.object_type === ASSET_KEY || d.title.toLowerCase() === ASSET_KEY
  );
  if (!def) throw new Error(`No definition for "${ASSET_KEY}"`);

  // 2) fetch that definition
  const detailUrl = `${BASE_URL}/custom_object_definitions/${def.id}.json`;
  const detailRes = await axios.get(detailUrl, { headers });
  return detailRes.data.custom_object_definition;
}

async function updateAsset(assetId, attributes) {
  const url = `${BASE_URL}/custom_objects/${ASSET_KEY}/records/${assetId}.json`;
  try {
    const r = await axios.patch(url, { attributes }, { headers });
    return r.data;
  } catch (e) {
    console.error('[updateAsset]', e.response?.status, e.response?.data);
    throw e;
  }
}

async function createAsset(data) {
  const url = `${BASE_URL}/custom_objects/${ASSET_KEY}/records.json`;
  try {
    const r = await axios.post(url, { record: { attributes: data } }, { headers });
    return r.data;
  } catch (e) {
    console.error('[createAsset]', e.response?.status, e.response?.data);
    throw e;
  }
}

// — Ticket creation —

async function createTicket(ticketData) {
  const url = `${BASE_URL}/tickets.json`;
  try {
    const r = await axios.post(url, { ticket: ticketData }, { headers });
    return r.data.ticket;
  } catch (e) {
    console.error('[createTicket]', e.response?.status, e.response?.data);
    throw e;
  }
}

module.exports = {
  // user
  searchUsers,
  getUserById,
  searchUserById,

  // org
  getOrganizations,
  getOrganizationById,

  // assets
  getAllAssets,
  getUserAssetsById,
  getAssetSchema,
  updateAsset,
  createAsset,

  // tickets
  createTicket,
};
