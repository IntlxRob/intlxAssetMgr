// zendesk.js

const axios = require('axios');

// Load environment variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;

const zendeskBaseUrl = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;

// Basic auth string
const auth = {
  username: `${ZENDESK_EMAIL}/token`,
  password: ZENDESK_API_TOKEN
};

// ========== API Functions ==========

async function searchUsers(name) {
  const url = `${zendeskBaseUrl}/users/search.json?query=${encodeURIComponent(name)}`;
  const response = await axios.get(url, { auth });
  return response.data.users;
}

async function getOrganizations() {
  const url = `${zendeskBaseUrl}/organizations.json`;
  const response = await axios.get(url, { auth });
  return response.data.organizations;
}

async function getAllAssets() {
  const url = `${zendeskBaseUrl}/custom_objects/asset/records`;
  const response = await axios.get(url, { auth });
  return response.data.records;
}

async function getUserAssetsByName(userName) {
  const allAssets = await getAllAssets();
  return allAssets.filter(asset => asset.fields.assigned_to_name === userName);
}

async function updateAsset(assetId, updateFields) {
  const url = `${zendeskBaseUrl}/custom_objects/asset/records/${assetId}`;
  const response = await axios.patch(url, {
    fields: updateFields
  }, { auth });
  return response.data;
}

async function createTicket(subject, description, requesterId) {
  const url = `${zendeskBaseUrl}/tickets.json`;
  const response = await axios.post(url, {
    ticket: {
      subject,
      comment: { body: description },
      requester_id: requesterId
    }
  }, { auth });
  return response.data.ticket;
}

// ========== Export ==========

module.exports = {
  searchUsers,
  getOrganizations,
  getAllAssets,
  getUserAssetsByName,
  updateAsset,
  createTicket
};
