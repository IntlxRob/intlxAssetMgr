// bin/dev-token.js
//
// Prints a short-lived ZAF-shaped JWT for testing the API by hand.
//
//   node bin/dev-token.js
//   curl -s -H "Authorization: Bearer $(node bin/dev-token.js)" localhost:3000/api/...
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
// Every route under /api now requires a signed request, so testing one by hand
// means minting a token. Doing that inline means either pasting the secret into
// a command — where it lands in shell history — or re-exporting it in every new
// terminal.
//
// This reads ZAF_SHARED_SECRET from .env, which is already gitignored and
// already holds every other credential in this repo, and prints only the token.
// The secret never appears in a command, in history, or in terminal scrolling.
//
// ---------------------------------------------------------------------------
// What it produces
// ---------------------------------------------------------------------------
// The same shape Zendesk's app proxy sends: HS256, with iat and exp, five
// minutes. So a token from here and a token from a real app request are
// indistinguishable to verifyZafJwt — which is the point. A test credential
// that takes a different path through the middleware tests the wrong thing.
//
// It identifies itself as iss "dev-token" so a rejection in the log can be
// told apart from a real app request. Nothing enforces that claim unless
// ZAF_EXPECTED_ISSUER is set, which it should not be in production.
//
// This is a development convenience and expects to be run locally. It does not
// talk to Zendesk or to the database.

'use strict';

require('dotenv').config({ quiet: true });

const { createHmac } = require('node:crypto');

const SECRET = (process.env.ZAF_SHARED_SECRET || '').trim();

if (!SECRET) {
  console.error(
    'dev-token: ZAF_SHARED_SECRET is not set.\n' +
      '\n' +
      '  Add it to .env in this directory (gitignored):\n' +
      '\n' +
      '      ZAF_SHARED_SECRET=<the same value as the app setting and Render>\n'
  );
  process.exit(1);
}

const TTL_SECONDS = parseInt(
  (process.argv.find((a) => a.startsWith('--ttl=')) || '').split('=')[1] || '300',
  10
);

const b64url = (input) =>
  Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const now = Math.floor(Date.now() / 1000);

const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const payload = b64url(
  JSON.stringify({ iat: now, exp: now + TTL_SECONDS, iss: 'dev-token' })
);
const signature = b64url(
  createHmac('sha256', SECRET).update(`${header}.${payload}`).digest()
);

// Only the token, and no trailing newline fuss — this is meant to be
// substituted straight into a header.
process.stdout.write(`${header}.${payload}.${signature}`);
