// services/zendesk.js
const axios = require('axios');

// Environment Variables
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL     = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN     = process.env.ZENDESK_API_TOKEN;

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const CUSTOM_OBJECT_KEY = 'asset';

// Axios instance with basic auth
const zendeskApi = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `Basic ${Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64')}`,
    'Content-Type': 'application/json',
  },
});

// Search users by name/email
async function searchUsers(query) {
  if (!query) return [];
  
  try {
    // If query is '*', get all users (limited to first page)
    if (query === '*') {
      const res = await zendeskApi.get('/users.json?per_page=100');
      return res.data.users || [];
    }
    
    const res = await zendeskApi.get(`/users/search.json?query=${encodeURIComponent(query)}`);
    return res.data.users || [];
  } catch (err) {
    console.error('Error searching users:', err.message);
    return [];
  }
}

// Search organizations by name
async function searchOrganizations(query) {
  if (!query) return [];
  const searchQuery = `name:"${query}"* type:organization`;
  const res = await zendeskApi.get(`/search.json?query=${encodeURIComponent(searchQuery)}`);
  return res.data.results || [];
}

// Get one user by ID
async function getUserById(id) {
  const res = await zendeskApi.get(`/users/${id}.json`);
  return res.data.user;
}

// Get one organization by ID
async function getOrganizationById(id) {
  const res = await zendeskApi.get(`/organizations/${id}.json`);
  return res.data.organization;
}

// List all organizations (using offset pagination - FIXED)
async function getOrganizations() {
  try {
    let allOrganizations = [];
    let nextPage = '/organizations.json?per_page=100';
    let pageCount = 0;

    while (nextPage && pageCount < 10) { // Safety limit to prevent infinite loops
      pageCount++;
      console.log(`[DEBUG] Page ${pageCount}: Fetching ${nextPage}`);
      
      const response = await zendeskApi.get(nextPage);
      const organizations = response.data.organizations || [];
      allOrganizations.push(...organizations);
      
      console.log(`[DEBUG] Page ${pageCount}: Found ${organizations.length} organizations`);
      console.log(`[DEBUG] Page ${pageCount}: Total so far: ${allOrganizations.length}`);
      console.log(`[DEBUG] Page ${pageCount}: next_page:`, response.data.next_page);
      console.log(`[DEBUG] Page ${pageCount}: previous_page:`, response.data.previous_page);
      
      // Check for next page using offset pagination format
      const nextUrl = response.data.next_page;
      
      if (nextUrl) {
        // Extract just the path and query from the full URL, removing /api/v2 prefix
        const url = new URL(nextUrl);
        let path = url.pathname + url.search;
        
        // Remove /api/v2 prefix since our baseURL already includes it
        if (path.startsWith('/api/v2')) {
          path = path.substring(7); // Remove '/api/v2'
        }
        
        nextPage = path;
        console.log(`[DEBUG] Page ${pageCount}: Continuing to next page: ${nextPage}`);
      } else {
        console.log(`[DEBUG] Page ${pageCount}: No more pages (next_page is null). Stopping pagination.`);
        nextPage = null;
      }
    }

    if (pageCount >= 10) {
      console.log(`[DEBUG] Hit safety limit of 10 pages. Total fetched: ${allOrganizations.length}`);
    }

    console.log(`[DEBUG] Final result: Fetched ${allOrganizations.length} organizations across ${pageCount} pages.`);
    return allOrganizations;
  } catch (err) {
    console.error('[DEBUG] Error fetching organizations:', err.message);
    console.error('[DEBUG] Error response data:', err.response?.data);
    return [];
  }
}

// Get a single asset by ID
async function getAssetById(assetId) {
  console.log(`[DEBUG] Fetching asset by ID: ${assetId}`);
  try {
    const response = await zendeskApi.get(`/custom_objects/${CUSTOM_OBJECT_KEY}/records/${assetId}.json`);
    const asset = response.data.custom_object_record;
    console.log(`[DEBUG] Successfully fetched asset:`, asset?.id);
    return asset;
  } catch (err) {
    console.error('[DEBUG] Error fetching asset by ID:', err.response?.data || err.message);
    throw err;
  }
}

// Get assets assigned to a particular Zendesk user ID
async function getUserAssetsById(userId) {
  console.log(`[DEBUG] Fetching all assets to filter for user ID: ${userId}`);
  try {
    let allRecords = [];
    let nextPage = `/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`;

    while (nextPage) {
      console.log(`[DEBUG] Fetching page: ${nextPage}`);
      const response = await zendeskApi.get(nextPage);
      const records = response.data.custom_object_records || [];
      allRecords.push(...records);
      nextPage = response.data.meta?.has_more ? response.data.links?.next : null;
    }

    console.log(`[DEBUG] Fetched a total of ${allRecords.length} assets across all pages.`);

    const userAssets = allRecords.filter(
      (record) => String(record.custom_object_fields?.assigned_to) === String(userId)
    );

    console.log(`[DEBUG] Found ${userAssets.length} assets assigned to user ID ${userId} after filtering.`);
    return userAssets;

  } catch (err) {
    console.error('[DEBUG] Error fetching all user assets:', err.response?.data || err.message);
    throw err;
  }
}

// Update an asset's attributes
async function updateAsset(assetId, attrs) {
  const payload = {
    custom_object_record: { custom_object_fields: attrs }
  };
  const res = await zendeskApi.patch(
    `/custom_objects/${CUSTOM_OBJECT_KEY}/records/${assetId}.json`,
    payload
  );
  return res.data.custom_object_record;
}

// Create a new asset record
async function createAsset(attrs) {
  const payload = {
    custom_object_record: { custom_object_fields: attrs }
  };
  const res = await zendeskApi.post(
    `/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`,
    payload
  );
  return res.data;
}

// Get the schema (fields + options) for your asset custom object
async function getAssetFields() {
  try {
    console.log('[DEBUG] Fetching asset schema fields...');
    const res = await zendeskApi.get(`/custom_objects/${CUSTOM_OBJECT_KEY}/fields.json`);
    console.log('[DEBUG] Successfully received asset schema from Zendesk API.');
    return res.data.custom_object_fields || [];
  } catch (err) {
    console.error('[DEBUG] Error fetching asset schema from Zendesk API:', err.response?.data || err.message);
    throw err;
  }
}

// Create a Zendesk ticket (if needed)
async function createTicket(ticketData) {
  const res = await zendeskApi.post('/tickets.json', { ticket: ticketData });
  return res.data.ticket;
}

module.exports = {
  // users
  searchUsers,
  getUserById,

  // orgs
  searchOrganizations,
  getOrganizationById,
  getOrganizations,

  // assets
  getUserAssetsById,
  getAssetById,
  updateAsset,
  createAsset,
  getAssetFields,

  // tickets
  createTicket,
};