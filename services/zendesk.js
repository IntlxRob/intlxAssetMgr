const axios = require("axios");

const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;

const zendeskApi = axios.create({
  baseURL: `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`,
  auth: {
    username: `${ZENDESK_EMAIL}/token`,
    password: ZENDESK_API_TOKEN,
  },
});

// 🔍 Search for users by query
async function searchUsers(query) {
  const res = await zendeskApi.get(`/users/search`, {
    params: { query },
  });
  return res.data.users;
}

// 🔍 Get all organizations
async function getOrganizations() {
  const res = await zendeskApi.get(`/organizations`);
  return res.data.organizations;
}

// ✅ Get assets assigned to a user by name (used for matching)
async function getUserAssetsByName(userName) {
  const response = await zendeskApi.get('/custom_objects/asset/records');
  const allAssets = response.data.data;

  const matched = allAssets.filter(record =>
    record.custom_object_fields?.assigned_to?.toLowerCase() === userName.toLowerCase()
  );

  return matched;
}

// 🧾 Get all asset records
async function getAllAssets() {
  const res = await zendeskApi.get('/custom_objects/asset/records');
  return res.data.data;
}

// ✏️ Update a specific asset
async function updateAsset(id, fields) {
  const res = await zendeskApi.patch(`/custom_objects/asset/records/${id}`, {
    custom_object_fields: fields,
  });
  return res.data.data;
}

// 🆕 Create a Zendesk ticket with asset request info
async function createTicket(ticketData) {
  const res = await zendeskApi.post(`/tickets`, {
    ticket: {
      subject: ticketData.subject,
      comment: { body: ticketData.description },
      requester: {
        name: ticketData.name,
        email: ticketData.email,
      },
      custom_fields: [
        { id: 360053267191, value: ticketData.approved_by },
      ],
    },
  });
  return res.data.ticket;
}

module.exports = {
  searchUsers,
  getOrganizations,
  getUserAssetsByName,
  getAllAssets,
  updateAsset,
  createTicket,
};
