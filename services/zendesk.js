require('dotenv').config();
const axios = require('axios');
const logger = require('./logger');

// Load environment variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN = process.env.ZENDESK_TOKEN;

const zendeskBaseUrl = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const zendeskAuth = {
  username: `${ZENDESK_EMAIL}/token`,
  password: ZENDESK_TOKEN,
};

logger.debug(`[INIT] zendesk.js loaded with domain: ${ZENDESK_SUBDOMAIN}`);

async function searchUsers(name) {
  logger.debug(`searchUsers() called with name: ${name}`);
  try {
    const response = await axios.get(`${zendeskBaseUrl}/users/search.json?query=${encodeURIComponent(name)}`, {
      auth: zendeskAuth,
    });
    return response.data.users;
  } catch (error) {
    logger.error("searchUsers: Request failed with status code", error.response?.status);
    return [];
  }
}

async function getOrganizations() {
  logger.debug("getOrganizations() called");
  try {
    const response = await axios.get(`${zendeskBaseUrl}/organizations.json`, {
      auth: zendeskAuth,
    });
    return response.data.organizations;
  } catch (error) {
    logger.error("getOrganizations: Request failed with status code", error.response?.status);
    return [];
  }
}

async function getAllAssets() {
  logger.debug("getAllAssets() called");
  try {
    const response = await axios.get(`${zendeskBaseUrl}/custom_objects/asset/records`, {
      auth: zendeskAuth,
    });
    return response.data.records || [];
  } catch (error) {
    logger.error("getAllAssets: Request failed with status code", error.response?.status);
    return [];
  }
}

async function getUserAssetsByName(userName) {
  logger.debug(`Requested user_name: "${userName}"`);
  try {
    const [users, assets, organizations] = await Promise.all([
      searchUsers(userName),
      getAllAssets(),
      getOrganizations(),
    ]);

    if (!users || !assets || !organizations) {
      logger.error("Missing data in getUserAssetsByName:", {
        usersExists: !!users,
        assetsExists: !!assets,
        orgsExists: !!organizations,
      });
      return [];
    }

    const user = users.find(u => u.name === userName);
    if (!user) {
      logger.warn(`No matching user found for: ${userName}`);
      return [];
    }

    const userAssets = assets.filter(a => a.assignee_id === user.id);
    const orgMap = Object.fromEntries(organizations.map(o => [o.id, o.name]));

    return userAssets.map(asset => ({
      ...asset,
      organization_name: orgMap[asset.organization_id] || 'Unknown',
    }));
  } catch (error) {
    logger.error("Error fetching user assets:", error.message || error);
    return [];
  }
}

async function updateAsset(assetId, data) {
  logger.debug(`updateAsset() called for ID: ${assetId} with data:`, data);
  try {
    const response = await axios.patch(`${zendeskBaseUrl}/custom_objects/asset/records/${assetId}`, data, {
      auth: zendeskAuth,
    });
    return response.data.record;
  } catch (error) {
    logger.error("updateAsset failed:", error.message || error);
    return null;
  }
}

async function createTicket(ticketData) {
  logger.debug("createTicket() called with data:", ticketData);
  try {
    const response = await axios.post(`${zendeskBaseUrl}/tickets.json`, { ticket: ticketData }, {
      auth: zendeskAuth,
    });
    return response.data.ticket;
  } catch (error) {
    logger.error("createTicket failed:", error.message || error);
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
