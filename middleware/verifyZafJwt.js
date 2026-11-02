// middleware/verifyZafJwt.js
//
// INBOUND verification for calls from the Ticket IQ apps.
//
// Three middlewares in this codebase touch Zendesk auth and they are NOT
// interchangeable:
//
//   services/zendeskAuth.js      OUTBOUND  — builds credentials for calls we
//                                            make TO Zendesk
//   middleware/verifyZendeskToken.js
//                                INBOUND   — a shared secret Zendesk's WEBHOOKS
//                                            send us, compared for equality
//   this file                    INBOUND   — a signed JWT the Zendesk APP
//                                            PROXY sends us, verified
//
// Do not merge them. The webhook one compares a static secret, which is right
// for webhooks because Zendesk holds that secret server-side and the value
// never changes. It is useless for a browser app, where any static secret
// would have to ship in the JavaScript bundle.
//
// ---------------------------------------------------------------------------
// How the token gets here
// ---------------------------------------------------------------------------
// The app declares a secure setting in manifest.json and sends
// `Authorization: Bearer {{jwt.token}}` through ZAF's client.request(). The
// app only ever transmits the placeholder. Zendesk's proxy signs a JWT with
// the stored secret — HS256, with `iat` and `exp` added automatically, five
// minutes by default — and substitutes it outside the browser.
//
// So the secret never reaches the browser, and the credential on the wire
// expires in minutes rather than being a bearer valid forever.
//
// Important consequence: these requests arrive from ZENDESK'S IP RANGES, not
// from the agent's browser. CORS does not apply to them. The `cors` and
// `secure` options are mutually exclusive in ZAF — a plain cross-origin
// fetch() cannot carry this token at all, which is why api.ts goes through
// client.request().
//
// In development the vite dev server signs the same kind of token itself, with
// the same secret, in its proxy `configure` hook. So dev presents exactly the
// credential production expects and there is NO development bypass in this
// file — see the note below, because that is a deliberate design choice and
// not an omission.
//
// ---------------------------------------------------------------------------
// What this does and does not prove
// ---------------------------------------------------------------------------
// It proves the request was signed with our shared secret — by Zendesk's proxy
// on behalf of an installation of our app, or by our own dev server.
//
// It does NOT identify the user, and it is not per-user authorization. Any
// agent with the app installed can reach any endpoint it guards. That is
// acceptable here — they are agents who can read these tickets in Zendesk
// anyway — but it is app-level auth, not user-level, and should not be
// mistaken for the latter later on. If per-user authorization is ever needed,
// the app must add its own identifying claims and this file must check them;
// ZAF does not supply user identity in the token by itself.
//
// ---------------------------------------------------------------------------
// Why there is no development bypass
// ---------------------------------------------------------------------------
// An earlier draft of this file accepted a static DEV_API_TOKEN as a second
// way to pass. That was a mistake, and the reason is specific: the vite dev
// proxy targets PRODUCTION, so for a dev token to be useful it would have to
// be set in Render — a long-lived bearer granting full access to real customer
// data, sitting in an environment variable indefinitely. That is the exact
// thing this middleware exists to remove.
//
// Having dev sign a real short-lived JWT instead costs twelve lines in
// vite.config.ts and leaves this file with one code path. One path cannot be
// left switched on by accident.
//
// There is also no NODE_ENV check anywhere here, because an unset NODE_ENV in
// production is how a development branch becomes a public endpoint.
//
// ---------------------------------------------------------------------------
// Failing closed, deliberately
// ---------------------------------------------------------------------------
// The Tier 2 table in the project notes lists four controls in this codebase
// that failed OPEN — written, configured, and skipped in silence:
//
//   if (ADMIN_KEY && provided !== ADMIN_KEY) reject   // no key -> no check
//   if (SHARED && provided !== SHARED) reject         // same shape
//   process.env.X || '<committed literal>'            // same idea
//   verifyZendeskToken imported but mounted on one route
//
// Every one reads as a guard and behaves as a pass-through when its config is
// absent. So the polarity here is the opposite: no secret configured means
// REJECT EVERYTHING, loudly, with a 503 that says why.

'use strict';

const jwt = require('jsonwebtoken');

const SHARED_SECRET = (process.env.ZAF_SHARED_SECRET || '').trim();

// Optional. If the caller adds an `iss` claim, require it to match. ZAF does
// not set one — the app would have to — so unset means "do not check", which
// is safe because the signature verification above it is not optional.
const EXPECTED_ISSUER = (process.env.ZAF_EXPECTED_ISSUER || '').trim();

module.exports = function verifyZafJwt(req, res, next) {
  // ---- fail closed -------------------------------------------------------
  if (!SHARED_SECRET) {
    console.error(
      'verifyZafJwt: ZAF_SHARED_SECRET is not configured — rejecting all ' +
        'requests. Set it in Render and as the app\'s secure setting; the two ' +
        'must match exactly.'
    );
    return res.status(503).json({
      error: 'auth-not-configured',
      message: 'request verification is not configured on this server'
    });
  }

  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'missing-credential',
      message: 'Authorization: Bearer <token> required'
    });
  }

  const token = header.slice(7).trim();
  if (!token) {
    return res.status(401).json({
      error: 'missing-credential',
      message: 'Authorization header carried no token'
    });
  }

  // ---- the only check ----------------------------------------------------
  let claims;
  try {
    claims = jwt.verify(token, SHARED_SECRET, {
      // Explicit, and not negotiable. Omitting this is how a verifier comes to
      // accept `alg: none`, or to verify an RS256 token by using its public
      // key as an HMAC secret. ZAF signs HS256 only, so anything else is an
      // attack or a misconfiguration, and both should fail.
      algorithms: ['HS256'],

      // ZAF sets exp five minutes out by default and jsonwebtoken enforces it.
      // A little tolerance for clock skew between Zendesk and Render.
      clockTolerance: 30,

      ...(EXPECTED_ISSUER ? { issuer: EXPECTED_ISSUER } : {})
    });
  } catch (error) {
    // Log the REASON, never the token. A rejected credential is still a
    // credential and still belongs in nobody's log file.
    const why = error && error.name ? error.name : 'VerifyError';
    const detail = error && error.message ? error.message : '';

    // The number of dot-separated segments separates the two causes on its
    // own: a real JWT has three, and an unsubstituted '{{jwt.token}}'
    // placeholder has one. A count is not content, so this is safe to log —
    // unlike the token, which is a credential even after being rejected.
    const segments = token.split('.').length;

    console.warn(
      `verifyZafJwt: rejected ${req.method} ${req.originalUrl} — ` +
        `${why}${detail ? ': ' + detail : ''} (segments=${segments})`
    );

    if (why === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'token-expired',
        message: 'the token has expired; the app should obtain a fresh one'
      });
    }

    return res.status(401).json({
      error: 'invalid-credential',
      message: 'token signature or claims did not verify'
    });
  }

  // Available to handlers that want to log or branch on it. Deliberately not
  // treated as identity — see the note at the top.
  req.zafAuth = { claims };
  return next();
};
