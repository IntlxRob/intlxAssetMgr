const axios = require('axios');

const ZENDESK_BASE_URL = 'https://intlxsolutions.zendesk.com/api/v2';

// Use environment variables for security, set:

const email = process.env.ZENDESK_EMAIL || 'rob.johnston@intlxsolutions.com';
const apiToken = process.env.ZENDESK_API_TOKEN || 'your_token_here';

const axiosInstance = axios.create({
  baseURL: ZENDESK_BASE_URL,
  auth: {
    username: `${email}/token`, // Note the '/token' suffix
    password: apiToken
  },
  headers: {
    'Content-Type': 'application/json',
  }
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

module.exports = {
  getUsers,
  getOrganizations,
  // ...other exports
};
