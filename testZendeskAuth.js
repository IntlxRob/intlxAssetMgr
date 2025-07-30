// testZendeskAuth.js
const axios = require('axios');

// 🔐 Replace with your actual credentials here (TEMPORARILY for local test only)
const ZENDESK_SUBDOMAIN = 'intlxsolutions';
const ZENDESK_EMAIL = 'rob.johnston@intlxsolutions.com';
const ZENDESK_TOKEN = 'LJ3usrUgoeBZ2fCnGJX2mawtixdr0XnOh7rxPSuI';

// 🔒 Basic Auth header
const authHeader = 'Basic ' + Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString('base64');

// 🔎 API URL
const url = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/me.json`;

axios.get(url, {
  headers: {
    Authorization: authHeader,
    'Content-Type': 'application/json',
  }
})
.then((response) => {
  console.log('[✅ SUCCESS] Authenticated Zendesk user:');
  console.log(JSON.stringify(response.data, null, 2));
})
.catch((error) => {
  console.error('[❌ ERROR] Zendesk auth failed');
  if (error.response) {
    console.error(`Status: ${error.response.status}`);
    console.error(error.response.data);
  } else {
    console.error(error.message);
  }
});
