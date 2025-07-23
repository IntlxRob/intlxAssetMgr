// services/zendesk.js

const axios = require('axios');

const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN || 'intlxsolutions';
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;
const ZENDESK_ASSET_OBJECT_KEY = process.env.ZENDESK_ASSET_OBJECT_KEY || 'asset';

const zendeskApi = axios.create({
  baseURL: `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`,
  auth: {
    username: `${ZENDESK_EMAIL}/token`,
    password: ZENDESK_API_TOKEN,
  },
});

/**
 * Test Zendesk connection
 */
async function testConnection() {
  const response = await zendeskApi.get('/users/me.json');
  return response.data;
}

/**
 * Get all assets and filter for those assigned to userId
 */
async function getUserAssets(userId) {
  try {
    const requestUrl = `/custom_objects/${ZENDESK_ASSET_OBJECT_KEY}/records.json`;
    console.log(`Fetching ALL assets from Zendesk: ${zendeskApi.defaults.baseURL}${requestUrl}`);
    const response = await zendeskApi.get(requestUrl);

    const allRecords = response.data.custom_object_records || [];
    console.log(`Fetched ${allRecords.length} total records.`);

    const userAssets = allRecords.filter(
      (record) => String(record.custom_object_fields?.assigned_to) === String(userId)
    );

    console.log(`Found ${userAssets.length} assets for user ID ${userId}`);
    return userAssets;
  } catch (error) {
    console.error(`Error in getUserAssets for user ID ${userId}:`, error.response?.data || error.message);
    return [];
  }
}

/**
 * Fetch all users with pagination
 */
async function getAllUsers() {
  const users = [];
  let url = '/users.json?page=1';
  try {
    while (url) {
      const res = await zendeskApi.get(url);
      users.push(...res.data.users);
      url = res.data.next_page ? res.data.next_page.replace(`https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`, '') : null;
    }
    return users;
  } catch (error) {
    console.error('Error fetching all users:', error.response?.data || error.message);
    return [];
  }
}

/**
 * Fetch all organizations with pagination
 */
async function getAllOrganizations() {
  const organizations = [];
  let url = '/organizations.json?page=1';
  try {
    while (url) {
      const res = await zendeskApi.get(url);
      organizations.push(...res.data.organizations);
      url = res.data.next_page ? res.data.next_page.replace(`https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`, '') : null;
    }
    return organizations;
  } catch (error) {
    console.error('Error fetching all organizations:', error.response?.data || error.message);
    return [];
  }
}

/**
 * Update an asset record
 */
async function updateAsset(assetId, fieldsToUpdate) {
  try {
    const response = await zendeskApi.patch(
      `/custom_objects/${ZENDESK_ASSET_OBJECT_KEY}/records/${assetId}.json`,
      {
        custom_object_record: {
          custom_object_fields: fieldsToUpdate,
        },
      }
    );
    return response.data.custom_object_record;
  } catch (error) {
    console.error(`Error updating asset ${assetId}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Create a new asset record
 */
async function createAsset(fields) {
  try {
    const response = await zendeskApi.post(
      `/custom_objects/${ZENDESK_ASSET_OBJECT_KEY}/records.json`,
      {
        custom_object_record: {
          custom_object_fields: fields,
        },
      }
    );
    return response.data.custom_object_record;
  } catch (error) {
    console.error('Error creating asset:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = {
  testConnection,
  getUserAssets,
  getAllUsers,
  getAllOrganizations,
  updateAsset,
  createAsset,
};
