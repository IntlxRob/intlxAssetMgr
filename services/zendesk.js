// services/zendesk.js
const axios = require('axios');

// 🔐 Environment (make sure ZENDESK_SUBDOMAIN, ZENDESK_EMAIL and ZENDESK_TOKEN are set)
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN     = process.env.ZENDESK_TOKEN;

const BASE_URL         = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const CUSTOM_OBJECT_KEY = 'asset';

// build auth header
const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${auth}`,
  'Content-Type': 'application/json',
};


/** ─── USERS ────────────────────────────────────────────────────────── **/

// search by name/email
async function searchUsers(query) {
  if (!query) return [];
  try {
    const { data } = await axios.get(
      `${BASE_URL}/users/search.json?query=${encodeURIComponent(query)}`,
      { headers }
    );
    return data.users || [];
  } catch (err) {
    console.error('[zendesk.searchUsers] error', err.response?.data || err);
    return [];
  }
}

// lookup one user
async function getUserById(id) {
  try {
    const { data } = await axios.get(
      `${BASE_URL}/users/${id}.json`,
      { headers }
    );
    return data.user || null;
  } catch (err) {
    console.error(`[zendesk.getUserById ${id}] error`, err.response?.data || err);
    return null;
  }
}


/** ─── ORGANIZATIONS ───────────────────────────────────────────────── **/

// list all
async function getOrganizations() {
  try {
    const { data } = await axios.get(
      `${BASE_URL}/organizations.json`,
      { headers }
    );
    return data.organizations || [];
  } catch (err) {
    console.error('[zendesk.getOrganizations] error', err.response?.data || err);
    return [];
  }
}

// lookup one
async function getOrganizationById(id) {
  try {
    const { data } = await axios.get(
      `${BASE_URL}/organizations/${id}.json`,
      { headers }
    );
    return data.organization || null;
  } catch (err) {
    console.error(`[zendesk.getOrganizationById ${id}] error`, err.response?.data || err);
    return null;
  }
}


/** ─── ASSETS ───────────────────────────────────────────────────────── **/

// fetch all asset records
async function getAllAssets() {
  try {
    const { data } = await axios.get(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
      { headers }
    );
    // v2 returns array under `data.data` or `custom_object_records`
    return data.data || data.custom_object_records || [];
  } catch (err) {
    console.error('[zendesk.getAllAssets] error', err.response?.data || err);
    return [];
  }
}

// filter assets by assigned_to = user_id
async function getUserAssetsById(userId) {
  try {
    const all = await getAllAssets();
    return all.filter(r => String(r.custom_object_fields?.assigned_to) === String(userId));
  } catch (err) {
    console.error('[zendesk.getUserAssetsById] error', err);
    return [];
  }
}

// update one record
async function updateAsset(id, attrs) {
  try {
    const { data } = await axios.patch(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records/${id}.json`,
      { attributes: attrs },
      { headers }
    );
    return data;
  } catch (err) {
    console.error(`[zendesk.updateAsset ${id}] error`, err.response?.data || err);
    throw err;
  }
}

// create new record
async function createAsset(record) {
  try {
    const { data } = await axios.post(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
      { record: { attributes: record } },
      { headers }
    );
    return data;
  } catch (err) {
    console.error('[zendesk.createAsset] error', err.response?.data || err);
    throw err;
  }
}

// fetch the Custom Object schema so front‐end can pull status options, etc.
async function getAssetFields() {
  try {
    // this is the correct schema endpoint for custom‐object records
    const { data } = await axios.get(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records/schema.json`,
      { headers }
    );
    // return its `fields` array (or fallback to raw schema)
    return data.fields || data.schema?.fields || [];
  } catch (err) {
    console.error('[zendesk.getAssetFields] error', err.response?.data || err);
    return [];
  }
}


/** ─── TICKETS ─────────────────────────────────────────────────────── **/

// create a zendesk ticket
async function createTicket(ticket) {
  try {
    const { data } = await axios.post(
      `${BASE_URL}/tickets.json`,
      { ticket },
      { headers }
    );
    return data.ticket;
  } catch (err) {
    console.error('[zendesk.createTicket] error', err.response?.data || err);
    throw err;
  }
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
