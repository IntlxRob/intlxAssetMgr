const axios = require('axios');

const ZENDESK_BASE_URL = 'https://intlxsolutions.zendesk.com/api/v2';
const AUTH_TOKEN = process.env.ZENDESK_API_TOKEN; // or hardcode if needed

const axiosInstance = axios.create({
  baseURL: ZENDESK_BASE_URL,
  headers: {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    'Content-Type': 'application/json'
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
  // other exports ...
  getUsers,
  getOrganizations,
};
