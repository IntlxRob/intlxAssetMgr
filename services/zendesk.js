const axios = require('axios');

// Zendesk API base URL - replace with your Zendesk subdomain
const ZENDESK_BASE_URL = 'https://intlxsolutions.zendesk.com/api/v2';

// Credentials for Basic Auth (email + /token) and API token
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL || 'rob.johnston@intlxsolutions.com';
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN || 'your_api_token_here';

// Create an axios instance with basic auth
const axiosInstance = axios.create({
  baseURL: ZENDESK_BASE_URL,
  auth: {
    username: `${ZENDESK_EMAIL}/token`, // Email with /token suffix as required by Zendesk API
    password: ZENDESK_API_TOKEN,
  },
  headers: {
    'Content-Type': 'application/json',
  },
});

// Fetch all users from Zendesk
async function getUsers() {
  try {
    const response = await axiosInstance.get('/users.json');
    return response.data.users;
  } catch (error) {
    console.error('Zendesk getUsers error:', error.response?.data || error.message);
    throw error;
  }
}

// Fetch all organizations from Zendesk
async function getOrganizations() {
  try {
    const response = await axiosInstance.get('/organizations.json');
    return response.data.organizations;
  } catch (error) {
    console.error('Zendesk getOrganizations error:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = {
  getUsers,
  getOrganizations,
};
