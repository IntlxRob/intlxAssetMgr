const axios = require('axios');

const ZENDESK_BASE_URL = 'https://intlxsolutions.zendesk.com/api/v2';
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;  // e.g. 'rob.johnston@intlxsolutions.com/token'
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;  // e.g. 'LJ3usrUgoeBZ2fCnGJX2mawtixdr0XnOh7rxPSuI'

const axiosInstance = axios.create({
  baseURL: ZENDESK_BASE_URL,
  auth: {
    username: ZENDESK_EMAIL,
    password: ZENDESK_API_TOKEN,
  },
  headers: {
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
  getUsers,
  getOrganizations,
};
