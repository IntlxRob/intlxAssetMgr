const axios = require("axios");

const ZENDESK_DOMAIN = process.env.ZENDESK_DOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;
const ZENDESK_ASSET_OBJECT_KEY = process.env.ZENDESK_ASSET_OBJECT_KEY || "asset";

const zendesk = axios.create({
  baseURL: `https://${ZENDESK_DOMAIN}`,
  auth: {
    username: `${ZENDESK_EMAIL}/token`,
    password: ZENDESK_API_TOKEN
  }
});

// 🔍 Search users
async function searchUsers(query) {
  if (!query || query.trim() === "") {
    console.warn("[WARN] searchUsers called with empty query");
    return [];
  }

  const res = await zendesk.get(`/api/v2/users/search.json?query=${encodeURIComponent(query)}`);
  return res.data.users;
}

// 👤 Get ticket info
async function getTicket(ticketId) {
  const res = await zendesk.get(`/api/v2/tickets/${ticketId}`);
  return res.data.ticket;
}

// 👤 Get requester info
async function getRequester(userId) {
  const res = await zendesk.get(`/api/v2/users/${userId}`);
  return res.data.user;
}

// 🏢 Get all organizations
async function getOrganizations() {
  const res = await zendesk.get(`/api/v2/organizations`);
  return res.data.organizations;
}

// 🔗 Get assets assigned to a user via custom field
async function getAssetsByUserId(userId) {
  if (!userId) throw new Error("Missing user ID for asset lookup.");

  try {
    const response = await zendesk.get(`/api/v2/custom_objects/records`, {
      params: {
        type: ZENDESK_ASSET_OBJECT_KEY,
        query: `assigned_to:${userId}`
      }
    });

    const assets = response.data.records || [];
    return assets;
  } catch (error) {
    console.error("❌ Error in getAssetsByUserId:", error.response?.data || error.message);
    throw new Error("Failed to retrieve user assets.");
  }
}

module.exports = {
  searchUsers,
  getTicket,
  getRequester,
  getOrganizations,
  getAssetsByUserId
};
