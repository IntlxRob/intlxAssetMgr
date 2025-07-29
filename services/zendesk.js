const axios = require('axios');

const ZENDESK_DOMAIN = process.env.ZENDESK_DOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;

const zendeskClient = axios.create({
  baseURL: `https://${ZENDESK_DOMAIN}/api/v2`,
  auth: {
    username: `${ZENDESK_EMAIL}/token`,
    password: ZENDESK_API_TOKEN,
  },
});

async function getUserAssetsByName(user_name) {
  try {
    console.log(`[DEBUG] 🔍 Looking for assets assigned to: "${user_name}"`);

    const response = await zendeskClient.get(`/custom_objects/records`, {
      params: {
        type: 'asset',
        page: 1,
        per_page: 100,
      },
    });

    const assets = response?.data?.data;

    console.log(`[DEBUG] ✅ Raw asset data from Zendesk:`, JSON.stringify(assets, null, 2));

    if (!Array.isArray(assets)) {
      console.error('[ERROR] 🔥 Asset response is not an array. Something went wrong.');
      return [];
    }

    const matched = assets.filter(asset => {
      const assignedTo = asset?.custom_object_fields?.assigned_to;
      return assignedTo?.toLowerCase() === user_name.toLowerCase();
    });

    console.log(`[DEBUG] ✅ Matched ${matched.length} assets for "${user_name}"`);
    return matched;
  } catch (error) {
    console.error('[ERROR] 💥 Failed to fetch user assets:', error?.response?.data || error.message);
    return [];
  }
}
