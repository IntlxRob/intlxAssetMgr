const axios = require('axios');
require('dotenv').config();

// ───── ENV VARS ─────
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN = process.env.ZENDESK_API_TOKEN;

if (!ZENDESK_SUBDOMAIN || !ZENDESK_EMAIL || !ZENDESK_TOKEN) {
  console.error('[❌ ERROR] Missing one or more required Zendesk env vars.');
}

const zendeskBaseURL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const authHeader = {
  auth: {
    username: `${ZENDESK_EMAIL}/token`,
    password: ZENDESK_TOKEN
  }
};

// ───── SEARCH USERS ─────
async function searchUsers(userName) {
  console.debug(`[DEBUG] searchUsers() called with name: "${userName}"`);
  try {
    const res = await axios.get(
      `${zendeskBaseURL}/users/search.json?query=${encodeURIComponent(userName)}`,
      authHeader
    );
    return res.data.users;
  } catch (err) {
    console.error(`[ERROR] searchUsers: ${err.message}`);
    if (err.response) console.error(err.response.data);
    return [];
  }
}

// ───── GET ALL ASSETS ─────
async function getAllAssets() {
  console.debug('[DEBUG] getAllAssets() called');
  try {
    const res = await axios.get(
      `${zendeskBaseURL}/custom_objects/asset/records`,
      authHeader
    );
    return res.data.data;
  } catch (err) {
    console.error(`[ERROR] getAllAssets: ${err.message}`);
    if (err.response) console.error(err.response.data);
    return [];
  }
}

// ───── GET ORGANIZATIONS ─────
async function getOrganizations() {
  console.debug('[DEBUG] getOrganizations() called');
  try {
    const res = await axios.get(
      `${zendeskBaseURL}/organizations`,
      authHeader
    );
    return res.data.organizations;
  } catch (err) {
    console.error(`[ERROR] getOrganizations: ${err.message}`);
    if (err.response) console.error(err.response.data);
    return [];
  }
}

// ───── GET ASSETS BY USER NAME ─────
async function getUserAssetsByName(name) {
  console.debug(`[DEBUG] getUserAssetsByName() called with: "${name}"`);
  try {
    const [users, assets] = await Promise.all([
      searchUsers(name),
      getAllAssets()
    ]);

    if (!users.length) {
      console.debug(`[DEBUG] No users found for name: "${name}"`);
      return [];
    }

    const userId = users[0].id;
    const userAssets = assets.filter(asset => asset.attributes.assigned_to === userId);
    console.debug(`[DEBUG] Matched ${userAssets.length} assets for: "${name}"`);
    return userAssets;
  } catch (err) {
    console.error(`[ERROR] getUserAssetsByName: ${err.message}`);
    return [];
  }
}

// ───── UPDATE ASSET RECORD ─────
async function updateAsset(assetId, updateData) {
  console.debug(`[DEBUG] updateAsset() called for ID: ${assetId}`);
  try {
    const res = await axios.patch(
      `${zendeskBaseURL}/custom_objects/asset/records/${assetId}`,
      { data: { attributes: updateData } },
      authHeader
    );
    return res.data;
  } catch (err) {
    console.error(`[ERROR] updateAsset: ${err.message}`);
    if (err.response) console.error(err.response.data);
    throw err;
  }
}

// ───── CREATE TICKET ─────
async function createTicket(ticketData) {
  console.debug('[DEBUG] createTicket() called');
  try {
    const res = await axios.post(
      `${zendeskBaseURL}/tickets.json`,
      { ticket: ticketData },
      authHeader
    );
    console.debug(`[DEBUG] Ticket created with ID: ${res.data.ticket.id}`);
    return res.data.ticket;
  } catch (err) {
    console.error(`[ERROR] createTicket: ${err.message}`);
    if (err.response) console.error(err.response.data);
    throw err;
  }
}

// ───── EXPORTS ─────
module.exports = {
  searchUsers,
  getAllAssets,
  getOrganizations,
  getUserAssetsByName,
  updateAsset,
  createTicket
};
