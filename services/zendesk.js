// zendesk.js
const axios = require('axios');
require('dotenv').config();

// Environment variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN = process.env.ZENDESK_TOKEN;
const ZENDESK_ASSET_OBJECT_KEY = process.env.ZENDESK_ASSET_OBJECT_KEY || 'asset';

const ZENDESK_BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;

const AUTH_HEADER = {
  Authorization: `Basic ${Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64')}`,
};

console.log('[DEBUG] zendesk.js loaded with domain:', ZENDESK_SUBDOMAIN);

async function searchUsers(name) {
  try {
    console.log('[DEBUG] searchUsers() called with name:', name);
    const response = await axios.get(`${ZENDESK_BASE_URL}/users/search.json?query=${encodeURIComponent(name)}`, {
      headers: AUTH_HEADER,
    });
    return response.data.users;
  } catch (error) {
    console.error('[ERROR] searchUsers:', error.message);
    return [];
  }
}

async function getOrganizations() {
  try {
    console.log('[DEBUG] getOrganizations() called');
    const response = await axios.get(`${ZENDESK_BASE_URL}/organizations.json`, {
      headers: AUTH_HEADER,
    });
    return response.data.organizations;
  } catch (error) {
    console.error('[ERROR] getOrganizations:', error.message);
    return [];
  }
}

async function getAllAssets() {
  try {
    console.log('[DEBUG] getAllAssets() called');
    const response = await axios.get(`${ZENDESK_BASE_URL}/custom_objects/${ZENDESK_ASSET_OBJECT_KEY}/records`, {
      headers: AUTH_HEADER,
    });
    return response.data.data;
  } catch (error) {
    console.error('[ERROR] getAllAssets:', error.message);
    return [];
  }
}

async function getUserAssetsByName(userName) {
  console.log('[DEBUG] Requested user_name:', JSON.stringify(userName));
  try {
    const assets = await getAllAssets();
    const filtered = assets.filter(asset => asset.fields?.assigned_to_name === userName);
    console.log(`[DEBUG] Matched ${filtered.length} assets for: "${userName}"`);
    return filtered;
  } catch (error) {
    console.error('[ERROR] getUserAssetsByName:', error.message);
    return [];
  }
}

async function updateAsset(recordId, updatedFields) {
  try {
    console.log(`[DEBUG] updateAsset() called for recordId: ${recordId}`);
    const response = await axios.patch(
      `${ZENDESK_BASE_URL}/custom_objects/${ZENDESK_ASSET_OBJECT_KEY}/records/${recordId}`,
      { fields: updatedFields },
      { headers: AUTH_HEADER }
    );
    return response.data;
  } catch (error) {
    console.error('[ERROR] updateAsset:', error.message);
    return null;
  }
}

async function createTicket(subject, comment, requesterId) {
  try {
    console.log(`[DEBUG] createTicket() called for requesterId: ${requesterId}`);
    const response = await axios.post(
      `${ZENDESK_BASE_URL}/tickets.json`,
      {
        ticket: {
          subject,
          comment: { body: comment },
          requester_id: requesterId,
        },
      },
      { headers: AUTH_HEADER }
    );
    return response.data.ticket;
  } catch (error) {
    console.error('[ERROR] createTicket:', error.message);
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
