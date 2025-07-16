// services/zendesk.js
// This file contains all the logic for interacting with the Zendesk API.

const axios = require('axios');

// --- CONFIGURATION ---
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_DOMAIN;
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;
const ZENDESK_USER_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_ASSET_OBJECT_KEY = process.env.ZENDESK_ASSET_OBJECT_KEY || 'asset';

// --- Zendesk API Helper ---
const zendeskApi = axios.create({
  baseURL: `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`,
  headers: {
    'Authorization': `Basic ${Buffer.from(`${ZENDESK_USER_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString('base64')}`,
    'Content-Type': 'application/json',
  },
});

/**
 * Tests the connection to the Zendesk API.
 */
async function testConnection() {
    console.log('Running Zendesk API connection test...');
    const response = await zendeskApi.get('/users/me.json');
    console.log('Zendesk API test successful!');
    return response.data;
}

/**
 * Creates a ticket and then creates asset records for each item.
 * @param {object} body - The request body containing assets, user info, etc.
 * @returns {object} - An object containing the created ticket and assets.
 */
async function createTicketAndAssets(body) {
    const { assets, name, email, subject, approved_by } = body;

    if (!assets || !Array.isArray(assets) || assets.length === 0) {
        throw new Error('Missing or invalid assets list.');
    }

    // 1. Create the ticket
    const itemsHtml = assets.map(a => `<li><strong>${a['Name']}</strong><br/><small>${a['Manufacturer']} / ${a['Model Number']}</small></li>`).join('');
    const htmlBody = `<p><strong>Requested items:</strong></p><ul>${itemsHtml}</ul><p>Requested by ${approved_by || name}</p>`;
    const ticketPayload = {
        ticket: {
            subject: subject || 'New Service Catalog Request',
            requester: { name, email },
            comment: { html_body: htmlBody },
        },
    };

    console.log("Attempting to create ticket...");
    const ticketResponse = await zendeskApi.post('/tickets.json', ticketPayload);
    const ticket = ticketResponse.data.ticket;
    console.log(`Successfully created ticket ID: ${ticket.id}`);

    // 2. Create asset records
    const createdAssets = [];
    for (const asset of assets) {
        const customFields = {
            'asset_name': asset.Name,
            'manufacturer': asset.Manufacturer,
            'model_number': asset['Model Number'],
            'ticket_id': ticket.id.toString(),
            'approved_by': approved_by,
        };
        const assetPayload = {
            custom_object_record: {
                custom_object_fields: customFields,
                relationships: { assigned_to: { data: { id: ticket.requester_id } } }
            }
        };
        try {
            console.log(`Attempting to create asset record for: ${asset.Name}`);
            const assetResponse = await zendeskApi.post(`/custom_objects/${ZENDESK_ASSET_OBJECT_KEY}/records.json`, assetPayload);
            createdAssets.push(assetResponse.data);
            console.log(`Successfully created asset record. New asset ID: ${assetResponse.data.custom_object_record.id}`);
        } catch (assetError) {
            console.error(`!!!!!!!! FAILED to create asset record for: ${asset.Name} !!!!!!!!`);
            console.error("Zendesk API Error:", assetError.response ? assetError.response.data : assetError.message);
            console.error("Data Sent:", JSON.stringify(assetPayload, null, 2));
            throw new Error(`Failed to create asset record for ${asset.Name}. Check the logs.`);
        }
    }
    return { ticket, assets: createdAssets };
}

/**
 * Gets all asset records associated with a given user ID.
 * @param {string} userId - The Zendesk user ID.
 * @returns {Array} - A list of asset records.
 */
async function getUserAssets(userId) {
    const response = await zendeskApi.get(`/custom_objects/${ZENDESK_ASSET_OBJECT_KEY}/records.json?filter[field]=assigned_to&filter[value]=${userId}`);
    return response.data.custom_object_records || [];
}

module.exports = {
    testConnection,
    createTicketAndAssets,
    getUserAssets,
};
