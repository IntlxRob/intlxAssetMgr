const axios = require("axios");

const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;

const authHeader = {
  Authorization:
    "Basic " +
    Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString("base64"),
};

// 🔹 Get the current ticket
async function getTicket(ticketId) {
  const url = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}.json`;
  const response = await axios.get(url, { headers: authHeader });
  return response.data.ticket;
}

// 🔹 Get the user by ID (used for requester and assignee info)
async function getUserById(userId) {
  console.debug("getUserById() called with ID:", userId);
  const url = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/${userId}.json`;
  try {
    const response = await axios.get(url, { headers: authHeader });
    return response.data.user;
  } catch (error) {
    console.error("Error in getUserById():", error.message);
    throw error;
  }
}

// 🔹 Get user assets (Zendesk custom object records)
async function getUserAssets(userId) {
  console.debug("getUserAssets() called for user:", userId);
  const url = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/custom_objects/asset/records?filter[assigned_to]=${userId}`;
  try {
    const response = await axios.get(url, { headers: authHeader });
    return response.data.records || [];
  } catch (error) {
    console.error("Error fetching user assets:", error.message);
    throw error;
  }
}

// 🔹 Get organization name by ID
async function getOrganization(orgId) {
  const url = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/organizations/${orgId}.json`;
  try {
    const response = await axios.get(url, { headers: authHeader });
    return response.data.organization.name;
  } catch (error) {
    console.error("Error fetching organization:", error.message);
    return null;
  }
}

// 🔹 Get all organizations
async function getOrganizations() {
  console.debug("getOrganizations() called");
  const url = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/organizations.json`;
  try {
    const response = await axios.get(url, { headers: authHeader });
    return response.data.organizations;
  } catch (error) {
    console.error("Error fetching organizations:", error.message);
    return [];
  }
}

// 🔹 Search users by query
async function searchUsers(query) {
  console.debug("searchUsers() called with name:", query);
  const url = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/search.json?query=${encodeURIComponent(
    query
  )}`;
  try {
    const response = await axios.get(url, { headers: authHeader });
    return response.data.users || [];
  } catch (error) {
    console.error("Error searching users:", error.message);
    return [];
  }
}

module.exports = {
  getTicket,
  getUserById,
  getUserAssets,
  getOrganization,
  getOrganizations,
  searchUsers,
};
