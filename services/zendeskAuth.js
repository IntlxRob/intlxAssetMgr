// services/zendeskAuth.js
//
// Single source of truth for OUTBOUND Zendesk authentication.
//
// ⚠️  NOT FOR INBOUND VERIFICATION.
//     middleware/verifyZendeskToken.js compares an incoming webhook value
//     against process.env.ZENDESK_API_TOKEN. That is the opposite direction:
//     same env var, used as an *expected* value rather than a credential we
//     present. Do not route it through this module, and do not "tidy up"
//     that file when the outbound credential changes — Zendesk's webhook
//     config, not this code, decides what arrives on the wire.
//
// ---------------------------------------------------------------------------
// Why this is more than a header builder
// ---------------------------------------------------------------------------
// The original plan was one static token in an env var. That is no longer
// possible. Zendesk OAuth access tokens now expire: default 30 minutes,
// maximum 48 hours, and the client_credentials grant issues NO refresh token
// — you re-request instead.
//
// For this backend that is not a corner case. The ticket sync sleeps 7s
// between requests for rate-limit safety, so 30 minutes is about 257
// requests. A large incremental sync WILL cross a token boundary mid-flight.
// So the module caches a token, mints a new one before expiry, and retries
// once on a 401. Call sites that want none of that can still just ask for
// headers.
//
// Precedence, highest first:
//   1. ZENDESK_OAUTH_CLIENT_ID + ZENDESK_OAUTH_CLIENT_SECRET  -> mint + cache
//   2. ZENDESK_OAUTH_TOKEN                                     -> static bearer
//   3. ZENDESK_EMAIL + ZENDESK_API_TOKEN                       -> legacy Basic
//
// Rollback is unsetting the OAuth vars. No code change, no revert of 26 edits.

'use strict';

const axios = require('axios');

const SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const EMAIL = process.env.ZENDESK_EMAIL;
const API_TOKEN = process.env.ZENDESK_API_TOKEN;

// Trimmed because a trailing newline pasted into Render's env editor is
// invisible in the dashboard and produces a 401 that reads like a revoked
// credential.
const env = (name) => (process.env[name] || '').trim();

const CLIENT_ID = env('ZENDESK_OAUTH_CLIENT_ID');
const CLIENT_SECRET = env('ZENDESK_OAUTH_CLIENT_SECRET');
const STATIC_TOKEN = env('ZENDESK_OAUTH_TOKEN');

// Zendesk permits 300–172800 seconds. We ask for the ceiling: fewer token
// requests, fewer chances to be minting a credential at the moment the sync
// needs one. Expiry is still handled, because asking is not the same as
// getting — the OAuth client's own configured maximum wins.
const REQUESTED_TTL = parseInt(env('ZENDESK_OAUTH_TTL') || '172800', 10);

// Narrow deliberately. Everything this backend does today is covered; a 403
// naming the missing scope is a better failure than blanket `read write`.
// Widen in the Zendesk client config, not here.
const SCOPES = env('ZENDESK_OAUTH_SCOPES') || [
  'tickets:read',
  'tickets:write',
  'users:read',
  'users:write',
  'organizations:read',
  'groups:read',
  'ticket_attachments:write',
  'satisfaction_ratings:read',
  'account_settings:read'
].join(' ');

const ZENDESK_API_BASE = `https://${SUBDOMAIN}.zendesk.com/api/v2`;
const TOKEN_URL = `https://${SUBDOMAIN}.zendesk.com/oauth/tokens`;

// Refresh this many ms before the stated expiry. Covers clock skew and a
// request that is issued just before the boundary and arrives just after.
const EXPIRY_MARGIN_MS = 120000;

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

let cached = null;        // { token, expiresAt }
let inFlight = null;      // Promise, so a burst of callers mints once

/**
 * 'oauth_client' | 'oauth_static' | 'basic' | 'none'
 * Exported so health endpoints and startup logs can report the live
 * credential without handling it.
 */
function authMode() {
  if (CLIENT_ID && CLIENT_SECRET) return 'oauth_client';
  if (STATIC_TOKEN) return 'oauth_static';
  if (EMAIL && API_TOKEN) return 'basic';
  return 'none';
}

function basicHeader() {
  return `Basic ${Buffer.from(`${EMAIL}/token:${API_TOKEN}`).toString('base64')}`;
}

async function mintToken() {
  const started = Date.now();

  const { data } = await axios.post(
    TOKEN_URL,
    {
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: SCOPES,
      expires_in: REQUESTED_TTL
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 20000
    }
  );

  if (!data || !data.access_token) {
    throw new Error('Zendesk token endpoint returned no access_token.');
  }

  // Trust the server's expires_in over what we asked for. The client's
  // configured maximum silently caps the request.
  const ttlMs = (Number(data.expires_in) || 1800) * 1000;
  const expiresAt = started + ttlMs;

  console.log(
    `🔑 Zendesk OAuth token minted, valid ${Math.round(ttlMs / 60000)}m ` +
    `(expires ${new Date(expiresAt).toISOString()})`
  );

  return { token: data.access_token, expiresAt };
}

/**
 * A valid bearer token, from cache when possible.
 * Concurrent callers share one mint rather than racing.
 */
async function getAccessToken() {
  if (cached && Date.now() < cached.expiresAt - EXPIRY_MARGIN_MS) {
    return cached.token;
  }

  if (!inFlight) {
    inFlight = mintToken()
      .then((result) => {
        cached = result;
        return result.token;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  return inFlight;
}

/** Drop the cached token. Called on a 401 so the next call re-mints. */
function invalidateToken() {
  cached = null;
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

/**
 * The Authorization header value alone.
 *
 * ASYNC — this is the one breaking change for call sites. It has to be,
 * because it may need to mint a token. Anything that built the header at
 * module load time (syncJobs.js did) must move the call inside the request
 * function.
 */
async function authHeader() {
  switch (authMode()) {
    case 'oauth_client':
      return `Bearer ${await getAccessToken()}`;
    case 'oauth_static':
      return `Bearer ${STATIC_TOKEN}`;
    case 'basic':
      return basicHeader();
    default:
      throw new Error(
        'No Zendesk credential configured. Set ZENDESK_OAUTH_CLIENT_ID + ' +
        'ZENDESK_OAUTH_CLIENT_SECRET, or ZENDESK_EMAIL + ZENDESK_API_TOKEN.'
      );
  }
}

/**
 * A complete headers object, JSON content type included. Works unchanged for
 * both axios and fetch, which is what the existing call sites use.
 *
 * `extra` merges last so a caller can override Content-Type — the uploads
 * endpoint in routes/api.js sends a file body, not JSON.
 */
async function authHeaders(extra = {}) {
  return {
    Authorization: await authHeader(),
    'Content-Type': 'application/json',
    ...extra
  };
}

// ---------------------------------------------------------------------------
// Request wrapper — the path worth migrating call sites to
// ---------------------------------------------------------------------------

/**
 * An authenticated Zendesk request with token expiry handled.
 *
 * `url` may be absolute or a path relative to /api/v2 ('/tickets.json').
 * Everything else is passed through to axios.
 *
 * On a 401 the cached token is dropped and the request is retried once. A
 * second 401 is a real credential problem and is thrown. This is what makes a
 * long sync survive a token boundary without every loop needing to know that
 * tokens expire.
 *
 * Rate limiting is deliberately NOT handled here — syncJobs.js already has
 * its own 429 backoff and its own pacing, and two layers of retry would
 * multiply rather than cooperate.
 */
async function zendeskRequest(config = {}) {
  const url = /^https?:\/\//.test(config.url || '')
    ? config.url
    : `${ZENDESK_API_BASE}${config.url || ''}`;

  const send = async () =>
    axios({
      ...config,
      url,
      headers: { ...(await authHeaders()), ...(config.headers || {}) }
    });

  try {
    return await send();
  } catch (err) {
    const status = err.response && err.response.status;
    if (status === 401 && authMode() === 'oauth_client') {
      console.warn('⚠️  Zendesk returned 401 — re-minting token and retrying once.');
      invalidateToken();
      return send();
    }
    throw err;
  }
}

const zendeskGet = (url, config = {}) =>
  zendeskRequest({ ...config, method: 'get', url });

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Confirm the credential works, and report who we are acting as.
 *
 * Worth calling at boot. An expired or revoked credential does not announce
 * itself: the sync fetches nothing, reports success, and the dashboard
 * quietly goes stale. That exact shape of failure has already cost this
 * system two multi-day outages — once a broken INSERT, once a cursor that
 * advanced past unsynced tickets. Both were invisible because nothing
 * checked whether the work had produced anything.
 *
 * Also reports the acting identity, which under client_credentials is the
 * Zendesk user who created the OAuth client — not something this code can
 * choose. If that name is not the service account, the client was created
 * from the wrong session and every write will keep being attributed to a
 * person.
 *
 * Resolves rather than throwing, and never logs the credential, so it is
 * safe to call from a health endpoint.
 */
async function verifyAuth() {
  const mode = authMode();

  if (mode === 'none') {
    return { ok: false, mode, message: 'No Zendesk credential configured.' };
  }

  try {
    const { data } = await zendeskGet('/users/me.json', { timeout: 15000 });
    const user = data && data.user;

    // A malformed header can produce a 200 with an anonymous user rather than
    // a 401, so the id is checked rather than assumed.
    if (!user || !user.id) {
      return { ok: false, mode, message: 'users/me.json returned no user.' };
    }

    return {
      ok: true,
      mode,
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      scopes: mode === 'oauth_client' ? SCOPES : null,
      tokenExpiresAt: cached ? new Date(cached.expiresAt).toISOString() : null
    };
  } catch (err) {
    return {
      ok: false,
      mode,
      status: err.response && err.response.status,
      // The axios config object would carry the credential, so only status
      // and message are surfaced.
      message:
        (err.response && err.response.data && err.response.data.error) ||
        err.message
    };
  }
}

/**
 * One line at boot naming the mode and the identity. Cheap, and it turns
 * "why is the dashboard empty" into a question answerable from the Render log
 * rather than from the database.
 */
async function logAuthStatus() {
  const result = await verifyAuth();

  if (result.ok) {
    console.log(
      `🔑 Zendesk auth: ${result.mode} — acting as ${result.name} ` +
      `<${result.email}> (id ${result.id}, role ${result.role})`
    );
  } else {
    console.error(
      `❌ Zendesk auth FAILED (mode ${result.mode}` +
      `${result.status ? `, HTTP ${result.status}` : ''}): ${result.message}`
    );
  }

  return result;
}

module.exports = {
  ZENDESK_API_BASE,
  ZENDESK_SUBDOMAIN: SUBDOMAIN,
  ZENDESK_OAUTH_SCOPES: SCOPES,
  authMode,
  authHeader,
  authHeaders,
  zendeskRequest,
  zendeskGet,
  invalidateToken,
  verifyAuth,
  logAuthStatus
};
