// src/proxyClient.js
//
// All calls from this app to the intlx asset-manager proxy go through here.
//
// The proxy requires `Authorization: Bearer <JWT>`, where the JWT is signed
// (HS256) with the shared secret. This is the same scheme Ticket IQ 2.5.0 uses.
// The secret is a *secure* app setting (`shared_secret`, see manifest.json) and
// never reaches the browser: with `secure: true` + `jwt`, Zendesk's server signs
// a short-lived token with the secret and substitutes `{{jwt.token}}`.
//
// Two adapters keep the existing call sites unchanged:
//   - proxyFetch(url, options)  -> fetch-style   { ok, status, json(), text() }
//   - proxyAxios.get/post/...   -> axios-style   { data }, errors with err.response

const AUTH_HEADER_VALUE = 'Bearer {{jwt.token}}';
const JWT_OPTIONS = { algorithm: 'HS256', secret_key: '{{setting.shared_secret}}' };

let zafClient = null;
function getClient() {
  if (!zafClient) {
    if (!window.ZAFClient) {
      throw new Error('ZAFClient not available: proxy calls only work inside Zendesk');
    }
    zafClient = window.ZAFClient.init();
  }
  return zafClient;
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

// Build a fetch-like Response from a ZAF response or ZAF error object.
function toResponse(raw) {
  const status = typeof raw?.status === 'number' ? raw.status : 0;
  let text = raw?.responseText;
  if (text === undefined || text === null) {
    text = raw?.responseJSON !== undefined ? JSON.stringify(raw.responseJSON) : '';
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: raw?.statusText || '',
    async text() {
      return text;
    },
    async json() {
      if (raw?.responseJSON !== undefined) return raw.responseJSON;
      return text ? JSON.parse(text) : null;
    },
  };
}

// Core request: always resolves with a fetch-like Response (never rejects on
// HTTP error status), matching how `fetch` behaves.
async function request(url, { method = 'GET', headers = {}, body } = {}) {
  const extraHeaders = { ...headers };
  const contentType = headerValue(extraHeaders, 'Content-Type');
  Object.keys(extraHeaders).forEach((k) => {
    if (k.toLowerCase() === 'content-type' || k.toLowerCase() === 'authorization') {
      delete extraHeaders[k];
    }
  });

  const options = {
    url,
    type: method.toUpperCase(),
    headers: { ...extraHeaders, Authorization: AUTH_HEADER_VALUE },
    secure: true,
    jwt: JWT_OPTIONS,
    httpCompleteResponse: true,
  };
  if (body !== undefined && body !== null) {
    options.data = body;
    options.contentType = contentType || 'application/json';
  }

  try {
    const raw = await getClient().request(options);
    return toResponse(raw);
  } catch (err) {
    // ZAF rejects on non-2xx; the error object carries status + responseText.
    if (err && typeof err.status === 'number') return toResponse(err);
    throw err; // network/ZAF failure: behave like fetch (reject)
  }
}

/** fetch-compatible replacement for calls to the proxy. */
export function proxyFetch(url, options = {}) {
  return request(url, options);
}

// axios-compatible adapter used by api.jsx and SearchInput.jsx
function withParams(url, params) {
  if (!params) return url;
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
  ).toString();
  if (!qs) return url;
  return url + (url.includes('?') ? '&' : '?') + qs;
}

async function axiosLike(method, url, data, config = {}) {
  const res = await request(withParams(url, config.params), {
    method,
    headers: config.headers,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  let parsed;
  try {
    parsed = await res.json();
  } catch {
    parsed = await res.text();
  }
  if (!res.ok) {
    const err = new Error(`Request failed with status code ${res.status}`);
    err.response = { status: res.status, data: parsed };
    throw err;
  }
  return { data: parsed, status: res.status };
}

export const proxyAxios = {
  get: (url, config) => axiosLike('GET', url, undefined, config),
  delete: (url, config) => axiosLike('DELETE', url, undefined, config),
  post: (url, data, config) => axiosLike('POST', url, data, config),
  put: (url, data, config) => axiosLike('PUT', url, data, config),
  patch: (url, data, config) => axiosLike('PATCH', url, data, config),
};
