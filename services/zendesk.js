// services/zendesk.js

const axios = require("axios");

const ZENDESK_DOMAIN = process.env.ZENDESK_DOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;

const zendeskApi = axios.create({
  baseURL: `https://${ZENDESK_DOMAIN}/api/v2`,
  auth: {
    username: `${ZENDESK_EMAIL}/token`,
    password: ZENDESK_API_TOKEN,
  },
});

/**
 * Get all organizations
 */
async function getOrganizations() {
  try {
    console.debug("getOrganizations() called");
    const response = await zendeskApi.get("/organizations");
    return response.data.organizations;
  } catch (error) {
    console.error("Error fetching organizations:", error.message);
    throw error;
  }
}

/**
 * Search users by name/email
 */
async function searchUsers(query) {
  console.debug("searchUsers() called with name:", JSON.stringify(query));
  if (!query || query.trim() === "") {
    console.warn("/users endpoint called with empty or missing query param");
    return [];
  }

  try {
    const response = await zendeskApi.get(`/users/search`, {
      params: { query },
    });
    return response.data.users;
  } catch (error) {
    console.error("Error searching users:", error.message);
    throw error;
  }
}

/**
 * Get a single user by ID
 */
async function getUserById(userId) {
  console.debug("getUserById() called with ID:", userId);
  try {
    const response = await zendeskApi.get(`/users/${userId}`);
    return response.data.user;
  } catch (error) {
    console.error("Error in getUserById():", error.message);
    throw error;
  }
}

/**
 * Get ticket details (for sidebar app)
 */
async function getTicket(ticketId) {
  try {
    const response = await zendeskApi.get(`/tickets/${ticketId}`);
    return response.data.ticket;
  } catch (error) {
    console.error("Error fetching ticket:", error.message);
    throw error;
  }
}

/**
 * Get user assets by requester ID (custom object)
 */
async function getUserAssets(userId) {
  try {
    console.debug("getUserAssets() called for user:", userId);
    const response = await zendeskApi.get(
      `/custom_objects/asset/records?filter[assigned_to]=${userId}`
    );
    return response.data.data || [];
  } catch (error) {
    console.error("Error fetching user assets:", error.message);
    throw error;
  }
}

module.exports = {
  getOrganizations,
  searchUsers,
  getUserById,       // ✅ newly added
  getTicket,
  getUserAssets,
};
