// src/api.jsx

import axios from 'axios';

const ZAFClient = window.ZAFClient;

// Allow proxy to be configured at runtime
let BASE = 'https://intlxassetmgr-proxy.onrender.com/api';

/**
 * Set the proxy URL (used by app.jsx)
 */
export function setProxy(newUrl) {
  if (!newUrl) return;
  BASE = newUrl.replace(/\/+$/, '') + '/api'; // trim trailing slash and add /api
  console.log('[API] setProxy ->', BASE);
}

/**
 * Human-friendly error text for toasts (used by app.jsx)
 */
export function apiErrorToText(err) {
  if (!err) return 'Unknown error';
  const status = err?.response?.status;
  const data = err?.response?.data;
  const msg =
    data?.message ||
    data?.error ||
    (typeof data === 'string' ? data : '') ||
    err?.message ||
    'Request failed';
  return status ? `${status}: ${msg}` : msg;
}

/**
 * Get current ticket info from Zendesk App Framework
 */
export async function getTicket() {
  const client = ZAFClient.init();
  const ticketData = await client.get('ticket');
  return ticketData.ticket;
}

/**
 * Fetch a single user by ID
 */
export async function getUserById(id) {
  try {
    const { data } = await axios.get(`${BASE}/users/${id}`);
    return data.user;
  } catch (err) {
    console.error('Error fetching user by ID:', err);
    return null;
  }
}

/**
 * Fetch a single user by ID (alias for app.jsx compatibility)
 */
export async function getUser(userId) {
  return getUserById(userId);
}

/**
 * Search users by name/email
 */
export async function searchUsers(query) {
  if (!query || !query.trim()) return [];
  try {
    const { data } = await axios.get(`${BASE}/users/search`, {
      params: { q: query }
    });
    return data.users || [];
  } catch (err) {
    console.error('Error searching users:', err);
    return [];
  }
}

/**
 * Fetch a single organization by ID
 */
export async function getOrganizationById(id) {
  try {
    const { data } = await axios.get(`${BASE}/organizations/${id}`);
    return data.organization;
  } catch (err) {
    console.error('Error fetching organization by ID:', err);
    return null;
  }
}

/**
 * Fetch a single organization by ID (alias for app.jsx compatibility)
 */
export async function getOrganization(orgId) {
  return getOrganizationById(orgId);
}

/**
 * Fetch all organizations
 */
export async function getOrganizations() {
  try {
    const { data } = await axios.get(`${BASE}/organizations`);
    return data.organizations || [];
  } catch (err) {
    console.error('Error fetching organizations:', err);
    return [];
  }
}

/**
 * Fetch all custom-object fields for "asset" (to drive dropdowns)
 */
export async function getAssetFields() {
  try {
    const { data } = await axios.get(`${BASE}/assets/schema`);
    return data.fields || [];
  } catch (err) {
    console.error('Error fetching asset fields:', err);
    return [];
  }
}

/**
 * (Optional) Fetch the full asset schema
 */
export async function getAssetSchema() {
  try {
    const { data } = await axios.get(`${BASE}/assets/schema`);
    return data;
  } catch (err) {
    console.error('Error fetching asset schema:', err);
    return null;
  }
}

/**
 * Fetch all assets assigned to a given user ID
 */
export async function getUserAssets(userId) {
  if (!userId) return [];
  try {
    const { data } = await axios.get(`${BASE}/user-assets`, {
      params: { user_id: userId }
    });
    return data.assets || [];
  } catch (err) {
    console.error('Error fetching user assets:', err);
    return [];
  }
}

/**
 * Fetch assets by user ID (alias for app.jsx compatibility)
 */
export async function getAssetsByUserId(userId) {
  return getUserAssets(userId);
}

/**
 * Fetch a single asset by ID (for app.jsx)
 */
export async function getAssetById(id) {
  try {
    const { data } = await axios.get(`${BASE}/assets/${id}`);
    return data.custom_object_record || data.record || data;
  } catch (err) {
    console.error('Error fetching asset by ID:', err);
    throw err;
  }
}

/**
 * Update an asset's properties (for app.jsx)
 */
export async function updateAsset(id, changes) {
  try {
    const payload = { properties: { ...(changes || {}) } };
    const { data } = await axios.patch(`${BASE}/assets/${id}`, payload);
    return data;
  } catch (err) {
    console.error('Error updating asset:', err);
    throw err;
  }
}

/**
 * Create a new asset record
 */
export async function createAsset(assetData) {
  try {
    const { data } = await axios.post(`${BASE}/assets`, assetData);
    return data;
  } catch (err) {
    console.error('Error creating asset:', err);
    throw err;
  }
}

/**
 * Create a new Zendesk ticket
 */
export async function createTicket(ticketData) {
  try {
    const { data } = await axios.post(`${BASE}/ticket`, ticketData);
    return data.ticket;
  } catch (err) {
    console.error('Error creating ticket:', err);
    throw err;
  }
}

/**
 * Parse asset info out of ticket comment HTML
 */
export function parseAssetsFromComment(commentHtml) {
  const container = document.createElement('div');
  container.innerHTML = commentHtml;
  const listItems = container.querySelectorAll('ul li');
  const parsed = [];

  listItems.forEach(li => {
    const asset = {};
    li.innerHTML.split('<br>').forEach(line => {
      const match = line.match(/<strong>([^<]+):<\/strong>\s*(.*)/);
      if (match) {
        const key = match[1].toLowerCase().replace(/\s+/g, '_');
        const value = match[2].replace(/<[^>]+>/g, '');
        asset[key] = value;
      }
    });
    if (Object.keys(asset).length) parsed.push(asset);
  });

  return parsed;
}