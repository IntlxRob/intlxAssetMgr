// api.js
// Centralized API helpers for the Asset Manager app.
//
// Key fixes:
// - Adds getAssetById(id) with cache-busting to avoid stale reads after PATCH.
// - updateAsset(id, changes) always wraps as { properties: {...} } and logs verbosely.
// - Consistent, high-signal console logs for req/resp/error paths.
// - Safe extractors for common Zendesk Custom Objects response shapes.
// - Added missing functions for React app compatibility.

import axios from 'axios';

// ---------- Config ----------

// Allow overriding at runtime. Falls back to your known proxy.
let PROXY =
  (typeof window !== 'undefined' && (window.PROXY || window.ASSETMGR_PROXY)) ||
  process.env.ASSETMGR_PROXY ||
  'https://intlxassetmgr-proxy.onrender.com';

export function setProxy(newUrl) {
  if (!newUrl) return;
  PROXY = newUrl.replace(/\/+$/, ''); // trim trailing slash
  console.log('[API] setProxy ->', PROXY);
}

// Optional place to add shared headers (auth, etc.)
export function defaultHeaders() {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

// ---------- Utils ----------

function logReq(tag, method, url, payload) {
  console.log(`[API][${tag}] ${method.toUpperCase()} ${url}`, payload ?? '');
}

function logRes(tag, res, picked) {
  const status = res?.status;
  const brief = picked ?? res?.data;
  console.log(`[API][${tag}] <-- ${status}`, brief);
}

function logErr(tag, err) {
  const status = err?.response?.status;
  const data = err?.response?.data;
  console.error(`[API][${tag}][ERROR]`, status, data || err);
}

// Human-friendly error text for toasts
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

// Safely pull a single record from varied shapes
function extractRecord(data) {
  return (
    data?.custom_object_record ||
    data?.record ||
    data?.data?.custom_object_record ||
    data?.data?.record ||
    data
  );
}

// Safely pull array from varied shapes
function extractRecords(data) {
  return (
    data?.custom_object_records ||
    data?.records ||
    data?.data?.custom_object_records ||
    data?.data?.records ||
    data?.assets ||  // Added for React app compatibility
    []
  );
}

// ---------- Assets ----------

// List assets by requester/user id (using user-assets endpoint for React app)
export async function getAssetsByUserId(userId) {
  const url = `${PROXY}/api/user-assets?user_id=${encodeURIComponent(userId)}`;
  const tag = 'Assets:listByUser';
  try {
    logReq(tag, 'get', url);
    const res = await axios.get(url, { headers: defaultHeaders() });
    const assets = extractRecords(res.data);
    logRes(tag, res, { count: assets.length ?? 0 });
    return assets; // Return the assets array directly for React app compatibility
  } catch (err) {
    logErr(tag, err);
    throw err;
  }
}

// NEW: fetch a single asset by id, with cache-busting so we never read stale data after a PATCH
export async function getAssetById(id) {
  const url = `${PROXY}/api/assets/${encodeURIComponent(id)}?t=${Date.now()}`;
  const tag = 'Asset:getById';
  try {
    logReq(tag, 'get', url);
    const res = await axios.get(url, { headers: defaultHeaders() });
    const rec = extractRecord(res.data);
    logRes(tag, res, { id: rec?.id, updated_at: rec?.updated_at });
    return rec;
  } catch (err) {
    logErr(tag, err);
    throw err;
  }
}

// Update an asset's properties (only send changed fields).
// `changes` should be a flat map of property keys -> values.
export async function updateAsset(id, changes) {
  const url = `${PROXY}/api/assets/${encodeURIComponent(id)}`;
  const tag = 'Asset:update';
  const payload = { properties: { ...(changes || {}) } };
  try {
    logReq(tag, 'patch', url, payload);
    const res = await axios.patch(url, payload, { headers: defaultHeaders() });
    // Some backends return the updated record; others return minimal info.
    const rec = extractRecord(res.data);
    logRes(tag, res, rec ? { id: rec?.id, updated_at: rec?.updated_at } : res.data);
    return res; // keep full axios response so caller can choose how to handle
  } catch (err) {
    logErr(tag, err);
    throw err;
  }
}

// ---------- Schema ----------

export async function getAssetSchema() {
  const url = `${PROXY}/api/assets/schema`;
  const tag = 'Schema:get';
  try {
    logReq(tag, 'get', url);
    const res = await axios.get(url, { headers: defaultHeaders() });
    // For convenience, surface any status options found
    const statusOptions =
      res?.data?.properties?.status?.options ||
      res?.data?.fields?.find?.((f) => f.key === 'status')?.options ||
      [];
    logRes(tag, res, { statusOptionsCount: statusOptions.length });
    return res.data;
  } catch (err) {
    logErr(tag, err);
    throw err;
  }
}

// ---------- Users / Orgs ----------

export async function getUser(userId) {
  const url = `${PROXY}/api/users/${encodeURIComponent(userId)}`;
  const tag = 'User:get';
  try {
    logReq(tag, 'get', url);
    const res = await axios.get(url, { headers: defaultHeaders() });
    logRes(tag, res, { id: res?.data?.id || userId, name: res?.data?.name });
    return res.data;
  } catch (err) {
    logErr(tag, err);
    throw err;
  }
}

export async function getOrganization(orgId) {
  const url = `${PROXY}/api/organizations/${encodeURIComponent(orgId)}`;
  const tag = 'Org:get';
  try {
    logReq(tag, 'get', url);
    const res = await axios.get(url, { headers: defaultHeaders() });
    logRes(tag, res, { id: res?.data?.id || orgId, name: res?.data?.name });
    return res.data;
  } catch (err) {
    logErr(tag, err);
    throw err;
  }
}

// ---------- New Functions for React App Compatibility ----------

// Get all users for dropdowns
export async function getUsers() {
  const url = `${PROXY}/api/users`;
  const tag = 'Users:getAll';
  try {
    logReq(tag, 'get', url);
    const res = await axios.get(url, { headers: defaultHeaders() });
    logRes(tag, res, { count: res?.data?.users?.length ?? 0 });
    return res.data.users || [];
  } catch (err) {
    logErr(tag, err);
    throw err;
  }
}

// Get all organizations for dropdowns  
export async function getOrganizations() {
  const url = `${PROXY}/api/organizations`;
  const tag = 'Organizations:getAll';
  try {
    logReq(tag, 'get', url);
    const res = await axios.get(url, { headers: defaultHeaders() });
    logRes(tag, res, { count: res?.data?.organizations?.length ?? 0 });
    return res.data.organizations || [];
  } catch (err) {
    logErr(tag, err);
    throw err;
  }
}

// Search users by query
export async function searchUsers(query) {
  const url = `${PROXY}/api/users/search?q=${encodeURIComponent(query)}`;
  const tag = 'Users:search';
  try {
    logReq(tag, 'get', url);
    const res = await axios.get(url, { headers: defaultHeaders() });
    logRes(tag, res, { count: res?.data?.users?.length ?? 0 });
    return res.data.users || [];
  } catch (err) {
    logErr(tag, err);
    throw err;
  }
}

// Search organizations by query
export async function searchOrganizations(query) {
  const url = `${PROXY}/api/organizations/search?q=${encodeURIComponent(query)}`;
  const tag = 'Organizations:search';
  try {
    logReq(tag, 'get', url);
    const res = await axios.get(url, { headers: defaultHeaders() });
    logRes(tag, res, { count: res?.data?.organizations?.length ?? 0 });
    return res.data.organizations || [];
  } catch (err) {
    logErr(tag, err);
    throw err;
  }
}

// Create a ticket (for React app new asset requests)
export async function createTicket(ticketData) {
  const url = `${PROXY}/api/ticket`;
  const tag = 'Ticket:create';
  try {
    logReq(tag, 'post', url, ticketData);
    const res = await axios.post(url, ticketData, { headers: defaultHeaders() });
    logRes(tag, res, { ticketId: res?.data?.ticket?.id });
    return res.data.ticket;
  } catch (err) {
    logErr(tag, err);
    throw err;
  }
}

// ---------- Convenience grouped export (optional) ----------

export const api = {
  setProxy,
  defaultHeaders,
  apiErrorToText,
  // assets
  getAssetsByUserId,
  getAssetById,      // use this right after PATCH to verify authoritatively
  updateAsset,
  // schema
  getAssetSchema,
  // users & orgs
  getUser,
  getOrganization,
  getUsers,          // NEW: for dropdowns
  getOrganizations,  // NEW: for dropdowns
  searchUsers,       // NEW: for search
  searchOrganizations, // NEW: for search
  // tickets
  createTicket,      // NEW: for React app
};

export default api;