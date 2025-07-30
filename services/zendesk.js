const axios = require('axios');
require('dotenv').config();

const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN = process.env.ZENDESK_API_TOKEN;
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;

const zendeskBaseURL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;

const encodedToken = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');
const authHeader = {
  headers: {
    Authorization: `Basic ${encodedToken}`,
    'Content-Type': 'application/json'
  }
};

async function searchUsers(name) {
  console.debug('[DEBUG] searchUsers() called with name:', name);
  try {
    const res = await axios.get(`${zendeskBaseURL}/users/search.json?query=${encodeURIComponent(name)}`, authHeader);
    return res.data.users;
  } catch (err) {
    console.error('[ERROR] searchUsers:', err.message);
    if (err.response) console.error(err.response.data);
    return [];
  }
}

async function getOrganizations() {
  console.debug('[DEBUG] getOrganizations() called');
  try {
    const res = await axios.get(`${zendeskBaseURL}/organizations.json`, authHeader);
    return res.data.organizations;
  } catch (err) {
    console.error('[ERROR] getOrganizations:', err.message);
    if (err.response) console.error(err.response.data);
    return [];
  }
}

async function getAllAssets() {
  console.debug('[DEBUG] getAllAssets() called');
  try {
    const res = await axios.get(`${zendeskBaseURL}/custom_objects/asset/records`, authHeader);
    return res.data.data;
  } catch (err) {
    console.error('[ERROR] getAllAssets:', err.message);
    if (err.response) console.error(err.response.data);
    return [];
  }
}

async function getUserAssetsByName(userName) {
  console.debug('[DEBUG] Requested user_name:', JSON.stringify(userName));
  const allAssets = await getAllAssets();
  try {
    const matched = allAssets.filter(
      (record) => record?.attributes?.assigned_user === userName
    );
    console.debug(`[DEBUG] Matched ${matched.length} assets for:`, JSON.stringify(userName));
    return matched;
  } catch (err) {
    console.error('Error fetching user assets:', err.message);
    return [];
  }
}

async function updateAsset(assetId, updateData) {
  console.debug('[DEBUG] updateAsset() called for ID:', assetId);
  try {
    const res = await axios.patch(
      `${zendeskBaseURL}/custom_objects/asset/records/${assetId}`,
      { data: { attributes: updateData } },
      authHeader
    );
    return res.data;
  } catch (err) {
    console.error(`[ERROR] updateAsset (${assetId}):`, err.message);
    if (err.response) console.error(err.response.data);
    return null;
  }
}

async function createTicket(subject, body, requester_id) {
  console.debug('[DEBUG] createTicket() called');
  try {
    const res = await axios.post(
      `${zendeskBaseURL}/tickets.json`,
      {
        ticket: {
          subject,
          comment: { body },
          requester_id
        }
      },
      authHeader
    );
    console.debug('[DEBUG] Ticket created with ID:', res.data.ticket.id);
    return res.data.ticket;
  } catch (err) {
    console.error('[ERROR] createTicket:', err.message);
    if (err.response) console.error(err.response.data);
    return null;
  }
}

module.exports = {
  searchUsers,
  getOrganizations,
  getAllAssets,
  getUserAssetsByName,
  updateAsset,
  createTicket,
};
