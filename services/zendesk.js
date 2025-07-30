// zendesk.js
const axios = require("axios");

const ZENDESK_DOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;

const zendesk = axios.create({
  baseURL: `https://${ZENDESK_DOMAIN}.zendesk.com/api/v2`,
  auth: {
    username: `${ZENDESK_EMAIL}/token`,
    password: ZENDESK_API_TOKEN,
  },
});

// 🔍 Get full user details by ID
async function getUserById(userId) {
  console.debug(`getUserById() called with ID: ${userId}`);
  try {
    const response = await zendesk.get(`/users/${userId}.json`);
    return response.data.user;
  } catch (error) {
    console.error("Error in getUserById():", error.message);
    throw error;
  }
}

// 🔍 Get assets assigned to a specific user
async function getUserAssets(userId) {
  console.debug(`getUserAssets() called for user: ${userId}`);
  try {
    const response = await zendesk.get(`/custom_objects/records?type=asset`);
    const allAssets = response.data.custom_object_records || [];
    const assigned = allAssets.filter(
      (record) => record.custom_object_fields?.assigned_to?.id === userId
    );
    return assigned.map((asset) => ({
      id: asset.id,
      ...asset.custom_object_fields,
    }));
  } catch (error) {
    console.error("Error fetching user assets:", error.message);
    throw error;
  }
}

// 🔍 Get ticket details
async function getTicket(ticketId) {
  try {
    const response = await zendesk.get(`/tickets/${ticketId}.json`);
    return response.data.ticket;
  } catch (error) {
    console.error("Error fetching ticket:", error.message);
    throw error;
  }
}

// 🔍 Get requester details (wrapper)
async function getRequester(userId) {
  return await getUserById(userId);
}

// 📦 Get all organizations
async function getOrganizations() {
  console.debug("getOrganizations() called");
  try {
    const response = await zendesk.get("/organizations.json");
    return response.data.organizations || [];
  } catch (error) {
    console.error("Error fetching organizations:", error.message);
    throw error;
  }
}

// 🔍 Search users by name or email
async function searchUsers(query) {
  console.debug(`searchUsers() called with name: "${query}"`);
  if (!query || !query.trim()) {
    console.warn("/users endpoint called with empty or missing query param");
    return [];
  }

  try {
    const response = await zendesk.get(`/users/search.json?query=${encodeURIComponent(query)}`);
    return response.data.users || [];
  } catch (error) {
    console.error("Error searching users:", error.message);
    throw error;
  }
}

// ➕ Create a new asset record
async function createAsset(assetData) {
  try {
    const response = await zendesk.post("/custom_objects/records", {
      custom_object_record: {
        type: "asset",
        custom_object_fields: assetData,
      },
    });
    return response.data.custom_object_record;
  } catch (error) {
    console.error("Error creating asset:", error.message);
    throw error;
  }
}

// 🧾 Parse asset info from ticket comment (if needed for parsing HTML)
function parseAssetsFromComment(commentHtml) {
  const container = document.createElement("div");
  container.innerHTML = commentHtml;
  const listItems = container.querySelectorAll("ul li");
  const parsed = [];

  listItems.forEach((li) => {
    const asset = {};
    const lines = li.innerHTML.split("<br>");
    lines.forEach((line) => {
      const match = line.match(/<strong>([^<]+):<\/strong>\s*(.*)/);
      if (match) {
        const key = match[1].toLowerCase().replace(/\s+/g, "_");
        const value = match[2].replace(/<[^>]+>/g, "");
        asset[key] = value;
      }
    });
    parsed.push(asset);
  });

  return parsed;
}

// ✅ Export all functions
module.exports = {
  getUserById,
  getUserAssets,
  getTicket,
  getRequester,
  getOrganizations,
  searchUsers,
  createAsset,
  parseAssetsFromComment,
};
