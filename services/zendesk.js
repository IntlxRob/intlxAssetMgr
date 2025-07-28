// /services/zendesk.js
const axios = require('axios');

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

// ✅ Test Zendesk connectivity
async function testConnection() {
  const response = await zendeskApi.get('/users/me.json');
  return response.data;
}

// ✅ Get all Zendesk users
async function getAllUsers() {
  const response = await zendeskApi.get('/users.json');
  return response.data.users;
}

// ✅ Get all Zendesk organizations
async function getAllOrganizations() {
  const response = await zendeskApi.get('/organizations.json');
  return response.data.organizations;
}

// ✅ Get user by ID
async function getUserById(userId) {
  const response = await zendeskApi.get(`/users/${userId}.json`);
  return response.data.user;
}

// ✅ Get organization by ID
async function getOrganizationById(orgId) {
  const response = await zendeskApi.get(`/organizations/${orgId}.json`);
  return response.data.organization;
}

// ✅ Get user-assigned assets (Zendesk custom object query)
async function getUserAssets(userId) {
  const response = await zendeskApi.get(`/custom_objects/asset/records`, {
    params: {
      query: `assigned_to:${userId}`,
    },
  });
  return response.data.data;
}

// ✅ Create a new asset (custom object record)
async function createAsset(assetData) {
  const response = await zendeskApi.post('/custom_objects/asset/records', {
    record: {
      custom_object_fields: assetData,
    },
  });
  return response.data.record;
}

// ✅ Update existing asset
async function updateAsset(assetId, updatedFields) {
  const response = await zendeskApi.patch(`/custom_objects/asset/records/${assetId}`, {
    record: {
      custom_object_fields: updatedFields,
    },
  });
  return response.data.record;
}

module.exports = {
  zendeskApi,
  testConnection,
  getAllUsers,
  getAllOrganizations,
  getUserById,
  getOrganizationById,
  getUserAssets,
  createAsset,
  updateAsset,
};
