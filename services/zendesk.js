const axios = require("axios");

const ZENDESK_SUBDOMAIN = "intlxsolutions";
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;
const ZENDESK_ASSET_OBJECT_KEY = "asset";

const zendeskApi = axios.create({
  baseURL: `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`,
  auth: {
    username: `${ZENDESK_EMAIL}/token`,
    password: ZENDESK_API_TOKEN,
  },
});

// Test Zendesk API
async function testConnection() {
  const res = await zendeskApi.get("/users/me.json");
  return res.data;
}

// Generic paginator
async function paginate(endpoint) {
  let results = [];
  let url = endpoint;

  while (url) {
    const res = await zendeskApi.get(url);
    const data = res.data;

    if (data.users) results.push(...data.users);
    else if (data.organizations) results.push(...data.organizations);
    else if (data.custom_object_records) results.push(...data.custom_object_records);

    url = data.next_page
      ? data.next_page.replace(`https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`, "")
      : null;
  }

  return results;
}

// Get all Zendesk users
async function getAllUsers() {
  return await paginate("/users.json?page=1");
}

// Get all Zendesk organizations
async function getAllOrganizations() {
  return await paginate("/organizations.json?page=1");
}

// Get all assets assigned to a specific user
async function getUserAssets(userId) {
  const allRecords = await paginate(`/custom_objects/${ZENDESK_ASSET_OBJECT_KEY}/records.json`);
  const filtered = allRecords.filter(
    (r) => String(r.custom_object_fields?.assigned_to) === String(userId)
  );
  console.log(`Found ${filtered.length} assets for user ID ${userId}`);
  return filtered;
}

// Create an individual asset
async function createAsset(assetData) {
  const payload = {
    name: assetData.name || `asset-${Date.now()}`,
    custom_object_fields: assetData.custom_object_fields || {},
  };

  const res = await zendeskApi.post(
    `/custom_objects/${ZENDESK_ASSET_OBJECT_KEY}/records`,
    payload
  );

  return res.data;
}

// Update a specific asset
async function updateAsset(assetId, fieldsToUpdate) {
  const payload = {
    custom_object_fields: fieldsToUpdate,
  };

  const res = await zendeskApi.patch(
    `/custom_objects/${ZENDESK_ASSET_OBJECT_KEY}/records/${assetId}`,
    payload
  );

  return res.data;
}

// Create ticket only
async function createTicket(payload) {
  const res = await zendeskApi.post("/tickets.json", payload);
  return res.data;
}

// Create ticket and assets (with org + timestamp in HTML)
async function createTicketAndAssets({ subject, description, name, email, approved_by, organization, assets }) {
  try {
    const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });

    const assetsHtml = assets.map(asset => `
      <li>
        <strong>Name:</strong> ${asset.Name || ''}<br/>
        <strong>Manufacturer:</strong> ${asset.Manufacturer || ''}<br/>
        <strong>Model:</strong> ${asset["Model Number"] || ''}
      </li>
    `).join('');

    const htmlBody = `
      <p><strong>Requested by:</strong> ${approved_by || name} (${email})</p>
      <p><strong>Organization:</strong> ${organization || 'N/A'}</p>
      <p><strong>Timestamp:</strong> ${now}</p>
      <p><strong>Assets Requested:</strong></p>
      <ul>${assetsHtml}</ul>
    `;

    const ticketPayload = {
      ticket: {
        subject: subject || "New Asset Request",
        comment: {
          html_body: htmlBody,
        },
        requester: {
          name,
          email,
        },
      },
    };

    const ticketRes = await createTicket(ticketPayload);
    const ticketId = ticketRes.ticket.id;
    const createdAssets = [];

    for (const asset of assets) {
      const assetPayload = {
        name: asset.Name || `asset-${Date.now()}`,
        custom_object_fields: {
          asset_name: asset.Name || "",
          manufacturer: asset.Manufacturer || "",
          model_number: asset["Model Number"] || "",
          description: asset.Description || "",
          url: asset.URL || "",
          ticket_id: ticketId,
          approved_by: approved_by || name,
        },
      };

      const res = await zendeskApi.post(
        `/custom_objects/${ZENDESK_ASSET_OBJECT_KEY}/records`,
        assetPayload
      );

      createdAssets.push(res.data);
    }

    return {
      ticket_id: ticketId,
      assets: createdAssets,
    };
  } catch (error) {
    console.error("createTicketAndAssets failed:", error.response?.data || error.message);
    throw error;
  }
}

module.exports = {
  zendeskApi,
  testConnection,
  getUserAssets,
  getAllUsers,
  getAllOrganizations,
  createAsset,
  updateAsset,
  createTicket,
  createTicketAndAssets,
};
