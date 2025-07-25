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

// --- Utilities ---
async function testConnection() {
  const res = await zendeskApi.get("/users/me.json");
  return res.data;
}

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

// --- Data Fetch ---
async function getAllUsers() {
  return await paginate("/users.json?page=1");
}

async function getAllOrganizations() {
  return await paginate("/organizations.json?page=1");
}

async function getUserAssets(userId) {
  const allRecords = await paginate(`/custom_objects/${ZENDESK_ASSET_OBJECT_KEY}/records.json`);
  return allRecords.filter(
    (r) => String(r.custom_object_fields?.assigned_to) === String(userId)
  );
}

async function getOrganizationName(orgId) {
  if (!orgId) {
    console.warn("No organization ID provided.");
    return null;
  }

  try {
    console.log(`Fetching organization name for ID: ${orgId}`);
    const res = await zendeskApi.get(`/organizations/${orgId}.json`);
    const name = res.data.organization?.name || `Org ${orgId}`;
    console.log(`Resolved organization name: ${name}`);
    return name;
  } catch (err) {
    console.error(`Failed to fetch org name for ID ${orgId}:`, err.message);
    return `Org ${orgId}`;
  }
}

// --- Asset Operations ---
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

// --- Ticket Operations ---
async function createTicket(payload) {
  const res = await zendeskApi.post("/tickets.json", payload);
  return res.data;
}

// --- Create Ticket & Asset Records ---
async function createTicketAndAssets({ subject, description, name, email, approved_by, organization, assets }) {
  try {
    console.log("=== Begin createTicketAndAssets ===");
    console.log("Incoming payload:", { subject, name, email, approved_by, organization, assets });

    const orgName = organization ? await getOrganizationName(organization) : "N/A";
    const timestamp = new Date().toLocaleString();

    const itemsHtml = assets.map((a) =>
      `<li><strong>${a.Name}</strong><br/><small>${a.Manufacturer} / ${a["Model Number"]}</small></li>`
    ).join("");

    const htmlBody = `
      <p><strong>Requested items:</strong></p>
      <ul>${itemsHtml}</ul>
      <p><strong>Requested by:</strong> ${approved_by || name}</p>
      <p><strong>Organization:</strong> ${orgName}</p>
      <p><strong>Timestamp:</strong> ${timestamp}</p>
    `;

    const ticketPayload = {
      ticket: {
        subject: subject || "New Asset Request",
        comment: { html_body: htmlBody },
        requester: { name, email },
      },
    };

    const ticketRes = await createTicket(ticketPayload);
    const ticketId = ticketRes.ticket.id;
    console.log(`Ticket created with ID: ${ticketId}`);

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
          organization: organization || null,
        },
      };

      const res = await zendeskApi.post(
        `/custom_objects/${ZENDESK_ASSET_OBJECT_KEY}/records`,
        assetPayload
      );

      createdAssets.push(res.data);
    }

    console.log("Assets created:", createdAssets.length);
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
  paginate,
  getAllUsers,
  getAllOrganizations,
  getUserAssets,
  getOrganizationName,
  createAsset,
  updateAsset,
  createTicket,
  createTicketAndAssets,
};
