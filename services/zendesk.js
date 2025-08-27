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

// Update an organization
async function updateOrganization(orgId, updateData) {
  try {
    console.log(`[Zendesk Service] Updating organization: ${orgId}`);
    console.log(`[Zendesk Service] Update data:`, updateData);
    
    const response = await zendeskApi.put(`/organizations/${orgId}.json`, { 
      organization: updateData 
    });
    
    console.log(`[Zendesk Service] Organization ${orgId} updated successfully`);
    return response.data.organization;
    
  } catch (error) {
    console.error(`[Zendesk Service] Error updating organization ${orgId}:`, error.message);
    throw error;
  }
}

// List all organizations (using offset pagination)
async function getOrganizations() {
  try {
    let allOrganizations = [];
    let nextPage = '/organizations.json?per_page=100';
    let pageCount = 0;

    while (nextPage && pageCount < 10) { // Safety limit to prevent infinite loops
      pageCount++;
      const response = await zendeskApi.get(nextPage);
      const organizations = response.data.organizations || [];
      allOrganizations.push(...organizations);
      
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
      } else {
        nextPage = null;
      }
    }

    return allOrganizations;
  } catch (err) {
    console.error('Error fetching organizations:', err.message);
    return [];
  }
}

// Get a single asset by ID
async function getAssetById(assetId) {
  try {
    const response = await zendeskApi.get(`/custom_objects/${CUSTOM_OBJECT_KEY}/records/${assetId}.json`);
    const asset = response.data.custom_object_record;
    return asset;
  } catch (err) {
    console.error('Error fetching asset by ID:', err.response?.data || err.message);
    throw err;
  }
}

// Get all assets (no filtering)
async function getAllAssets() {
  try {
    console.log(`[Zendesk Service] Fetching all assets`);
    
    let allRecords = [];
    let nextPage = `/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`;
    let pageCount = 0;

    while (nextPage && pageCount < 50) { // Safety limit
      pageCount++;
      console.log(`[Zendesk Service] Fetching page ${pageCount} of assets`);
      
      const response = await zendeskApi.get(nextPage);
      const records = response.data.custom_object_records || [];
      allRecords.push(...records);
      
      // Check for next page
      if (response.data.meta?.has_more && response.data.links?.next) {
        nextPage = response.data.links.next;
        
        // Remove base URL if present
        if (nextPage.includes(BASE_URL)) {
          nextPage = nextPage.replace(BASE_URL, '');
        }
      } else {
        nextPage = null;
      }
    }

    console.log(`[Zendesk Service] Retrieved ${allRecords.length} total assets`);
    return allRecords;

  } catch (err) {
    console.error('Error fetching all assets:', err.response?.data || err.message);
    throw err;
  }
}

// Get assets assigned to a particular organization ID
async function getAssetsByOrganizationId(organizationId) {
  try {
    console.log(`[Zendesk Service] Fetching assets for organization: ${organizationId}`);
    
    let allRecords = [];
    let nextPage = `/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`;
    let pageCount = 0;

    while (nextPage && pageCount < 50) { // Safety limit
      pageCount++;
      console.log(`[Zendesk Service] Fetching page ${pageCount} for organization assets`);
      
      const response = await zendeskApi.get(nextPage);
      const records = response.data.custom_object_records || [];
      allRecords.push(...records);
      
      // Check for next page
      if (response.data.meta?.has_more && response.data.links?.next) {
        nextPage = response.data.links.next;
        
        // Remove base URL if present
        if (nextPage.includes(BASE_URL)) {
          nextPage = nextPage.replace(BASE_URL, '');
        }
      } else {
        nextPage = null;
      }
    }

    // Filter assets by organization ID
    const orgAssets = allRecords.filter(record => {
      const assetOrgId = record.custom_object_fields?.organization || 
                        record.custom_object_fields?.assigned_to_org;
      
      // Try multiple comparison methods since IDs might be strings or numbers
      return assetOrgId == organizationId || 
             assetOrgId === organizationId || 
             assetOrgId?.toString() === organizationId?.toString();
    });

    console.log(`[Zendesk Service] Found ${orgAssets.length} assets for organization ${organizationId} out of ${allRecords.length} total assets`);
    
    // Log organization IDs found for debugging
    const orgIds = new Set();
    allRecords.forEach(record => {
      const orgId = record.custom_object_fields?.organization || 
                   record.custom_object_fields?.assigned_to_org;
      if (orgId) orgIds.add(orgId);
    });
    console.log(`[Zendesk Service] Organization IDs found in assets:`, Array.from(orgIds));
    
    return orgAssets;

  } catch (err) {
    console.error('Error fetching organization assets:', err.response?.data || err.message);
    throw err;
  }
}

// Get assets assigned to a particular Zendesk user ID
async function getUserAssetsById(userId) {
  try {
    let allRecords = [];
    let nextPage = `/custom_objects/${CUSTOM_OBJECT_KEY}/records.json`;

    while (nextPage) {
      const response = await zendeskApi.get(nextPage);
      const records = response.data.custom_object_records || [];
      allRecords.push(...records);
      nextPage = response.data.meta?.has_more ? response.data.links?.next : null;
    }

    const userAssets = allRecords.filter(
      (record) => String(record.custom_object_fields?.assigned_to) === String(userId)
    );

    return userAssets;

  } catch (err) {
    console.error('Error fetching all user assets:', err.response?.data || err.message);
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

// Delete an asset by ID
async function deleteAsset(assetId) {
  try {
    console.log(`[Zendesk Service] Deleting asset: ${assetId}`);
    
    const response = await zendeskApi.delete(`/custom_objects/${CUSTOM_OBJECT_KEY}/records/${assetId}.json`);
    
    console.log(`[Zendesk Service] Asset ${assetId} deleted successfully`);
    return true;
    
  } catch (error) {
    console.error(`[Zendesk Service] Error deleting asset ${assetId}:`, error.message);
    throw error;
  }
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
    const res = await zendeskApi.get(`/custom_objects/${CUSTOM_OBJECT_KEY}/fields.json`);
    return res.data.custom_object_fields || [];
  } catch (err) {
    console.error('Error fetching asset schema from Zendesk API:', err.response?.data || err.message);
    throw err;
  }
}

// Create a Zendesk ticket (if needed)
async function createTicket(ticketData) {
  const res = await zendeskApi.post('/tickets.json', { ticket: ticketData });
  return res.data.ticket;
}

// Test connection to Zendesk API
async function testConnection() {
  try {
    const response = await zendeskApi.get('/users/me.json');
    return {
      success: true,
      user: response.data.user.email,
      subdomain: ZENDESK_SUBDOMAIN
    };
  } catch (err) {
    console.error('Zendesk API test failed:', err.message);
    throw err;
  }
}

module.exports = {
  // Connection test
  testConnection,
  
  // users
  searchUsers,
  getUserById,

  // orgs
  searchOrganizations,
  getOrganizationById,
  updateOrganization,
  getOrganizations,

  // assets
  getAllAssets,
  getAssetsByOrganizationId,
  getUserAssetsById,
  getAssetById,
  updateAsset,
  deleteAsset,
  createAsset,
  getAssetFields,

  // tickets
  createTicket,
};