const axios = require('axios');

// 🔐 Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN     = process.env.ZENDESK_API_TOKEN;

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const CUSTOM_OBJECT_KEY = 'asset';

const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const headers = {
  Authorization: `Basic ${auth}`,
  'Content-Type': 'application/json',
};

async function searchUsers(name) {
  if (!name) return [];
  try {
    const res = await axios.get(`${BASE_URL}/users/search.json?query=${encodeURIComponent(name)}`, { headers });
    return res.data.users || [];
  } catch (err) {
    console.error('[zendesk.searchUsers] error', err.response?.data || err);
    return [];
  }
}

async function getUserById(id) {
  try {
    const res = await axios.get(`${BASE_URL}/users/${id}.json`, { headers });
    return res.data.user;
  } catch (err) {
    console.error('[zendesk.getUserById] error', err.response?.data || err);
    return null;
  }
}

async function getOrganizations() {
  try {
    const res = await axios.get(`${BASE_URL}/organizations.json`, { headers });
    return res.data.organizations || [];
  } catch (err) {
    console.error('[zendesk.getOrganizations] error', err.response?.data || err);
    return [];
  }
}

async function getOrganizationById(id) {
  try {
    const res = await axios.get(`${BASE_URL}/organizations/${id}.json`, { headers });
    return res.data.organization;
  } catch (err) {
    console.error('[zendesk.getOrganizationById] error', err.response?.data || err);
    return null;
  }
}

async function getAllAssets() {
  try {
    const res = await axios.get(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
      { headers }
    );
    // two possible response shapes:
    return res.data.data
      || res.data.custom_object_records
      || [];
  } catch (err) {
    console.error('[zendesk.getAllAssets] error', err.response?.data || err);
    return [];
  }
}

async function getUserAssetsById(userId) {
  try {
    const all = await getAllAssets();
    return all.filter(record => {
      const assigned = record.custom_object_fields?.assigned_to;
      return String(assigned) === String(userId);
    });
  } catch (err) {
    console.error('[zendesk.getUserAssetsById] error', err);
    return [];
  }
}

async function updateAsset(id, attributes) {
  try {
    const res = await axios.patch(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records/${id}.json`,
      { attributes },
      { headers }
    );
    return res.data;
  } catch (err) {
    console.error('[zendesk.updateAsset] error', err.response?.data || err);
    throw err;
  }
}

async function createAsset(attributes) {
  try {
    const res = await axios.post(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
      { record: { attributes } },
      { headers }
    );
    return res.data;
  } catch (err) {
    console.error('[zendesk.createAsset] error', err.response?.data || err);
    throw err;
  }
}

async function getAssetFields() {
  try {
    const res = await axios.get(
      `${BASE_URL}/custom_objects/${CUSTOM_OBJECT_KEY}/metadata/fields.json`,
      { headers }
    );
    return res.data.fields || [];
  } catch (err) {
    console.error('[zendesk.getAssetFields] error', err.response?.data || err);
    return [];
  }
}

async function createTicket(ticketData) {
  try {
    const res = await axios.post(
      `${BASE_URL}/tickets.json`,
      { ticket: ticketData },
      { headers }
    );
    return res.data.ticket;
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
