const axios = require('axios');

// Load env variables
const ZENDESK_DOMAIN = process.env.ZENDESK_DOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN = process.env.ZENDESK_TOKEN;

const zendesk = axios.create({
  baseURL: `https://${ZENDESK_DOMAIN}/api/v2`,
  auth: {
    username: `${ZENDESK_EMAIL}/token`,
    password: ZENDESK_TOKEN,
  }
});

// 🔍 Search users by name or email
async function searchUsers(query) {
  const res = await zendesk.get(`/users/search.json?query=${encodeURIComponent(query)}`);
  return res.data.users;
}

// 🔍 Get all organizations
async function getOrganizations() {
  const res = await zendesk.get(`/organizations.json`);
  return res.data.organizations;
}

// ✅ Get assets assigned to a user (filter by user_name)
async function getUserAssetsByName(user_name) {
  const allAssets = await getAllAssets();
  if (!Array.isArray(allAssets)) throw new Error("Asset list is not an array");
  return allAssets.filter(asset => asset.custom_object_fields?.assigned_to === user_name);
}

// 🧾 Get all assets
async function getAllAssets() {
  const res = await zendesk.get(`/custom_objects/asset/records`);
  return res.data.data || [];
}

// ✏️ Update a specific asset record
async function updateAsset(id, updates) {
  const res = await zendesk.patch(`/custom_objects/asset/records/${id}`, {
    custom_object_fields: updates
  });
  return res.data;
}

// 🆕 Create a ticket from asset request
async function createTicket({ subject, comment, requester, organization_id }) {
  const res = await zendesk.post('/tickets.json', {
    ticket: {
      subject,
      comment: { body: comment },
      requester,
      organization_id
    }
  });
  return res.data.ticket;
}

// 🧪 DEBUG LOG (optional during development)
console.log('[DEBUG] zendeskService loaded with functions: ', {
  searchUsers: typeof searchUsers,
  getOrganizations: typeof getOrganizations,
  getUserAssetsByName: typeof getUserAssetsByName,
  getAllAssets: typeof getAllAssets,
  updateAsset: typeof updateAsset,
  createTicket: typeof createTicket,
});

module.exports = {
  searchUsers,
  getOrganizations,
  getUserAssetsByName,
  getAllAssets,
  updateAsset,
  createTicket
};
