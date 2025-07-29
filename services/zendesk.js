// zendesk.js
require('dotenv').config();
const axios = require('axios');

const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;

const zendeskBaseUrl = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const auth = {
  username: `${ZENDESK_EMAIL}/token`,
  password: ZENDESK_API_TOKEN,
};

async function searchUsers(query) {
  try {
    const response = await axios.get(`${zendeskBaseUrl}/users/search.json?query=${encodeURIComponent(query)}`, { auth });
    console.debug('[DEBUG] searchUsers response:', response.data);
    return response.data.users || [];
  } catch (error) {
    console.error('Error fetching users:', error.message);
    return [];
  }
}

async function getOrganizations() {
  try {
    const response = await axios.get(`${zendeskBaseUrl}/organizations.json`, { auth });
    console.debug('[DEBUG] getOrganizations response:', response.data);
    return response.data.organizations || [];
  } catch (error) {
    console.error('Error fetching organizations:', error.message);
    return [];
  }
}

async function getAllAssets() {
  try {
    const url = `${zendeskBaseUrl}/custom_objects/asset/records`;
    const response = await axios.get(url, { auth });
    console.debug('[DEBUG] getAllAssets() response:', response.data);
    return response.data.records || [];
  } catch (error) {
    console.error('Error in getAllAssets:', error.message);
    return [];
  }
}

async function getUserAssetsByName(userName) {
  try {
    console.debug('[DEBUG] Looking for assets assigned to:', userName);
    const allAssets = await getAllAssets();
    const userAssets = allAssets.filter(asset => asset.fields?.assigned_to_name === userName);
    console.debug(`[DEBUG] Found ${userAssets.length} asset(s) for ${userName}`);
    return userAssets;
  } catch (error) {
    console.error('Error fetching user assets:', error.message);
    return [];
  }
}

async function updateAsset(assetId, updatedFields) {
  try {
    const url = `${zendeskBaseUrl}/custom_objects/asset/records/${assetId}`;
    const response = await axios.patch(url, { fields: updatedFields }, { auth });
    console.debug('[DEBUG] updateAsset response:', response.data);
    return response.data.record;
  } catch (error) {
    console.error('Error updating asset:', error.message);
    return null;
  }
}

async function createTicket(subject, body, requesterId) {
  try {
    const response = await axios.post(
      `${zendeskBaseUrl}/tickets.json`,
      {
        ticket: {
          subject,
          comment: { body },
          requester_id: requesterId,
        },
      },
      { auth }
    );
    console.debug('[DEBUG] createTicket response:', response.data);
    return response.data.ticket;
  } catch (error) {
    console.error('Error creating ticket:', error.message);
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
