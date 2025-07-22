// services/zendesk.js
const axios = require('axios');

const ZENDESK_BASE_URL = 'https://intlxsolutions.zendesk.com/api/v2';
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL; // your Zendesk login email
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN; // your Zendesk API token

const axiosInstance = axios.create({
  baseURL: ZENDESK_BASE_URL,
  auth: {
    username: `${ZENDESK_EMAIL}/token`,
    password: ZENDESK_API_TOKEN,
  },
  headers: {
    'Content-Type': 'application/json',
  },
});

async function getUsers() {
  try {
    const response = await axiosInstance.get('/users.json');
    return response.data.users;
  } catch (error) {
    console.error('Zendesk getUsers error:', error.response?.data || error.message);
    throw error;
  }
}

async function getOrganizations() {
  try {
    const response = await axiosInstance.get('/organizations.json');
    return response.data.organizations;
  } catch (error) {
    console.error('Zendesk getOrganizations error:', error.response?.data || error.message);
    throw error;
  }
}

async function getUserAssets(userId) {
  try {
    // Adjust the endpoint & query param according to your Zendesk custom objects schema
    const url = `/custom_objects/asset/records.json?filter[assigned_to]=${userId}`;
    const response = await axiosInstance.get(url);
    return response.data.assets || response.data.records; // confirm your API response
  } catch (error) {
    console.error('Zendesk getUserAssets error:', error.response?.data || error.message);
    throw error;
  }
}

async function createAsset(assetData) {
  try {
    const response = await axiosInstance.post('/custom_objects/asset/records.json', {
      record: assetData,
    });
    return response.data;
  } catch (error) {
    console.error('Zendesk createAsset error:', error.response?.data || error.message);
    throw error;
  }
}

async function updateAsset(assetId, fieldsToUpdate) {
  try {
    const url = `/custom_objects/asset/records/${assetId}.json`;
    const response = await axiosInstance.patch(url, {
      record: fieldsToUpdate,
    });
    return response.data;
  } catch (error) {
    console.error('Zendesk updateAsset error:', error.response?.data || error.message);
    throw error;
  }
}

async function createTicketAndAssets(data) {
  try {
    // Implement your ticket + asset creation logic here.
    // Example: create a ticket, then create related asset records.
    // Return combined results or IDs.
    throw new Error('createTicketAndAssets function is not yet implemented');
  } catch (error) {
    console.error('Zendesk createTicketAndAssets error:', error.response?.data || error.message);
    throw error;
  }
}

async function testConnection() {
  try {
    // Simple test call to verify connectivity/auth
    return await getUsers();
  } catch (error) {
    throw error;
  }
}

module.exports = {
  getUsers,
  getOrganizations,
  getUserAssets,
  createAsset,
  updateAsset,
  createTicketAndAssets,
  testConnection,
};
