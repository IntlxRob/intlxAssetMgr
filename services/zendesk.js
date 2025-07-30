// zendesk.js

const axios = require("axios");

const {
  ZENDESK_SUBDOMAIN,
  ZENDESK_EMAIL,
  ZENDESK_API_TOKEN,
} = process.env;

const zendesk = axios.create({
  baseURL: `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`,
  auth: {
    username: `${ZENDESK_EMAIL}/token`,
    password: ZENDESK_API_TOKEN,
  },
});

async function getTicket(ticketId) {
  console.debug(`getTicket() called with ID: ${ticketId}`);
  const response = await zendesk.get(`/tickets/${ticketId}`);
  return response.data.ticket;
}

async function getRequester(requesterId) {
  console.debug(`getRequester() called with ID: ${requesterId}`);
  const response = await zendesk.get(`/users/${requesterId}`);
  return response.data.user;
}

async function getUserById(userId) {
  console.debug(`getUserById() called with ID: ${userId}`);
  const response = await zendesk.get(`/users/${userId}`);
  return response.data.user;
}

async function getOrganization(orgId) {
  console.debug(`getOrganization() called with ID: ${orgId}`);
  const response = await zendesk.get(`/organizations/${orgId}`);
  return response.data.organization;
}

async function getOrganizations() {
  console.debug("getOrganizations() called");
  const response = await zendesk.get(`/organizations`);
  return response.data.organizations;
}

async function searchUsers(name) {
  console.debug(`searchUsers() called with name: "${name}"`);
  const response = await zendesk.get(`/users/search?query=${encodeURIComponent(name)}`);
  return response.data.users;
}

async function getUserAssets(userId) {
  console.debug(`getUserAssets() called for user: ${userId}`);
  try {
    const response = await zendesk.post(`/custom_objects/records/search`, {
      type: "asset",
      query: {
        field: "assigned_to",
        operator: "is",
        value: userId,
      },
    });
    return response.data.custom_object_records || [];
  } catch (error) {
    console.error("Error fetching user assets:", error.message);
    throw error;
  }
}

async function parseAssetsFromComment(comment) {
  try {
    const lines = comment.split("\n").filter((line) => line.includes(":"));
    const assets = [];
    let asset = {};
    for (const line of lines) {
      const [keyRaw, valueRaw] = line.split(":");
      const key = keyRaw.trim().toLowerCase().replace(/ /g, "_");
      const value = valueRaw.trim();
      if (key === "asset_name" && Object.keys(asset).length > 0) {
        assets.push(asset);
        asset = {};
      }
      asset[key] = value;
    }
    if (Object.keys(asset).length > 0) assets.push(asset);
    return assets;
  } catch (error) {
    console.error("Error parsing assets from comment:", error);
    return [];
  }
}

async function createAsset(data) {
  try {
    const response = await zendesk.post("/custom_objects/records", {
      custom_object_record: {
        type: "asset",
        attributes: data,
      },
    });
    return response.data.custom_object_record;
  } catch (error) {
    console.error("Error creating asset:", error.message);
    throw error;
  }
}

// Export all functions
module.exports = {
  getTicket,
  getRequester,
  getUserById,
  getOrganization,
  getOrganizations,
  searchUsers,
  getUserAssets,
  parseAssetsFromComment,
  createAsset,
};
