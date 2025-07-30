const axios = require('axios');

const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;
const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const OBJECT_TYPE = 'asset';

const headers = {
  Authorization: `Basic ${Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString('base64')}`,
  'Content-Type': 'application/json',
};

// 🔍 Search Zendesk users by name
async function searchUsers(name) {
  try {
    console.log('searchUsers() called with name:', name);
    const response = await axios.get(`${BASE_URL}/users/search.json?query=${encodeURIComponent(name)}`, { headers });
    return response.data.users;
  } catch (error) {
    console.error('Error searching users:', error.message);
    return [];
  }
}

// 👥 Get all organizations
async function getOrganizations() {
  try {
    console.log('getOrganizations() called');
    const response = await axios.get(`${BASE_URL}/organizations.json`, { headers });
    return response.data.organizations;
  } catch (error) {
    console.error('Error fetching organizations:', error.message);
    return [];
  }
}

// 📦 Get all assets
async function getAllAssets() {
  try {
    const response = await axios.get(`${BASE_URL}/custom_objects/${OBJECT_TYPE}/records`, { headers });
    return response.data.custom_object_records;
  } catch (error) {
    console.error('Error fetching all assets:', error.message);
    return [];
  }
}

// 📦 Get assets assigned to a user by user ID
async function getUserAssetsById(userId) {
  try {
    console.log('getUserAssets() called for user:', userId);
    const response = await axios.post(`${BASE_URL}/custom_objects/${OBJECT_TYPE}/records/search`, {
      query: {
        field: 'assigned_to',
        operator: 'is',
        value: userId
      }
    }, { headers });
    return response.data.custom_object_records;
  } catch (error) {
    console.error('Error fetching user assets:', error.message);
    return [];
  }
}

// 👤 Get user details by user ID
async function getUserById(userId) {
  try {
    console.log('getUserById() called with ID:', userId);
    const response = await axios.get(`${BASE_URL}/users/${userId}.json`, { headers });
    return response.data.user;
  } catch (error) {
    console.error('Error in getUserById():', error.message);
    return null;
  }
}

// 🛠️ Update an asset record
async function updateAsset(id, fields) {
  try {
    const response = await axios.patch(`${BASE_URL}/custom_objects/${OBJECT_TYPE}/records/${id}`, {
      custom_object_record: { fields }
    }, { headers });
    return response.data.custom_object_record;
  } catch (error) {
    console.error('Error updating asset:', error.message);
    return null;
  }
}

// ➕ Create a new asset
async function createAsset(fields) {
  try {
    const response = await axios.post(`${BASE_URL}/custom_objects/${OBJECT_TYPE}/records`, {
      custom_object_record: { fields }
    }, { headers });
    return response.data.custom_object_record;
  } catch (error) {
    console.error('Error creating asset:', error.message);
    return null;
  }
}

// 🎫 Create a Zendesk ticket
async function createTicket(subject, comment, requester_id) {
  try {
    const response = await axios.post(`${BASE_URL}/tickets.json`, {
      ticket: {
        subject,
        comment: { body: comment },
        requester_id
      }
    }, { headers });
    return response.data.ticket;
  } catch (error) {
    console.error('Error creating ticket:', error.message);
    return null;
  }
}

// ✅ Export all functions
module.exports = {
  searchUsers,
  getOrganizations,
  getAllAssets,
  getUserAssetsById,
  getUserAssets: getUserAssetsById, // alias for frontend
  getUserById,
  updateAsset,
  createAsset,
  createTicket,
};
