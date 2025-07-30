const axios = require('axios');

// Use console in place of logger
const logger = console;

// Env variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN = process.env.ZENDESK_TOKEN;

// Helper to build Zendesk API headers
const zendeskHeaders = {
  headers: {
    Authorization: `Basic ${Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64')}`,
    'Content-Type': 'application/json',
  },
};

// GET /users/search?query=name
async function searchUsers(name) {
  logger.debug(`searchUsers() called with name: ${name}`);
  try {
    const url = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/search.json?query=${encodeURIComponent(name)}`;
    const res = await axios.get(url, zendeskHeaders);
    return res.data.users;
  } catch (err) {
    logger.error('searchUsers: Request failed with status code', err?.response?.status);
    return [];
  }
}

// GET /organizations
async function getOrganizations() {
  logger.debug('getOrganizations() called');
  try {
    const url = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/organizations.json`;
    const res = await axios.get(url, zendeskHeaders);
    return res.data.organizations;
  } catch (err) {
    logger.error('getOrganizations: Request failed with status code', err?.response?.status);
    return [];
  }
}

// GET /custom_objects/asset/records
async function getAllAssets() {
  logger.debug('getAllAssets() called');
  try {
    const url = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/custom_objects/asset/records`;
    const res = await axios.get(url, zendeskHeaders);
    return res.data.data || [];
  } catch (err) {
    logger.error('getAllAssets: Request failed with status code', err?.response?.status);
    return [];
  }
}

// Match user name to assets
async function getUserAssetsByName(userName) {
  logger.debug(`Requested user_name: "${userName}"`);
  const [assets, organizations, users] = await Promise.all([
    getAllAssets(),
    getOrganizations(),
    searchUsers(userName),
  ]);

  const user = users?.[0];
  const org = organizations?.find(o => o.id === user?.organization_id);
  const userId = user?.id;
  const orgId = org?.id;

  if (!userId && !orgId) {
    logger.warn(`No matching user or organization found for: "${userName}"`);
    return [];
  }

  const matchedAssets = assets.filter(asset =>
    asset.custom_fields?.assigned_to_user_id === userId ||
    asset.custom_fields?.organization_id === orgId
  );

  logger.debug(`Matched ${matchedAssets.length} assets for: "${userName}"`);
  return matchedAssets;
}

// PATCH /custom_objects/asset/records/{id}
async function updateAsset(assetId, fieldsToUpdate) {
  logger.debug(`updateAsset(${assetId}) with fields: ${JSON.stringify(fieldsToUpdate)}`);
  try {
    const url = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/custom_objects/asset/records/${assetId}`;
    await axios.patch(url, { custom_fields: fieldsToUpdate }, zendeskHeaders);
    logger.info(`Asset ${assetId} updated successfully.`);
    return true;
  } catch (err) {
    logger.error(`Failed to update asset ${assetId}:`, err?.response?.data || err.message);
    return false;
  }
}

// POST /tickets
async function createTicket(ticketData) {
  logger.debug('createTicket() called with:', ticketData?.subject);
  try {
    const url = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`;
    const res = await axios.post(url, { ticket: ticketData }, zendeskHeaders);
    logger.info(`Ticket created with ID: ${res?.data?.ticket?.id}`);
    return res.data.ticket;
  } catch (err) {
    logger.error('createTicket failed:', err?.response?.data || err.message);
    return null;
  }
}

// Exports
module.exports = {
  searchUsers,
  getOrganizations,
  getAllAssets,
  getUserAssetsByName,
  updateAsset,
  createTicket,
};
