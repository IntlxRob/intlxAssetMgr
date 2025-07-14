// index.js
// A Node.js/Express service that mirrors the Python/Flask implementation for handling
// Zendesk asset requests from a Google Sheet catalog.
// FIX: Corrected syntax and added detailed error logging for custom object creation.

const express = require('express');
const cors =require('cors');
const axios = require('axios');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const app = express();
const port = process.env.PORT || 3000;

// --- CONFIGURATION (Set as Environment Variables on Render) ---
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_DOMAIN;
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;
const ZENDESK_USER_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_ASSET_OBJECT_KEY = process.env.ZENDESK_ASSET_OBJECT_KEY || 'asset';

// Google Sheets Configuration
const GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL;
const GOOGLE_CREDS_JSON = process.env.GOOGLE_CREDS_JSON;

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Zendesk API Helper ---
const zendeskApi = axios.create({
  baseURL: `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`,
  headers: {
    'Authorization': `Basic ${Buffer.from(`${ZENDESK_USER_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString('base64')}`,
    'Content-Type': 'application/json',
  },
});

// --- Google Sheets Helper ---
async function getSheetCatalog() {
  if (!GOOGLE_CREDS_JSON || !GOOGLE_SHEET_URL) {
    throw new Error('Google Sheets environment variables are not configured.');
  }
  const creds = JSON.parse(GOOGLE_CREDS_JSON);
  const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  
  const sheetIdMatch = GOOGLE_SHEET_URL.match(/\/d\/(.+?)\//);
  if (!sheetIdMatch || !sheetIdMatch[1]) throw new Error('Invalid Google Sheet URL. Could not extract Sheet ID.');

  const doc = new GoogleSpreadsheet(sheetIdMatch[1], serviceAccountAuth);
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  const rows = await sheet.getRows();
  return rows.map(row => row.toObject());
}


// --- ROUTES ---

/**
 * Root route to confirm the service is running.
 */
app.get("/", (req, res) => {
  res.send("Zendesk Catalog + Asset Proxy is up!");
});


/**
 * Endpoint to fetch the service catalog from Google Sheets.
 */
app.get('/api/catalog', async (req, res) => {
  try {
    const catalog = await getSheetCatalog();
    res.json(catalog);
  } catch (error) {
    console.error('Error fetching catalog:', error.message);
    res.status(500).json({ error: 'Failed to fetch catalog from Google Sheets.', details: error.message });
  }
});

/**
 * Endpoint to create a new ticket and associated asset records.
 */
app.post('/api/ticket', async (req, res) => {
  const { assets, name, email, subject, approved_by } = req.body;

  if (!assets || !Array.isArray(assets) || assets.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid assets list.' });
  }

  try {
    // 1. Create the ticket
    const itemsHtml = assets.map(a => `
      <li><strong>${a['Name']}</strong><br/>
      ${a['Description'] || ''}<br/>
      <small>${a['Manufacturer'] || ''} / ${a['Model Number'] || ''}</small><br/>
      <a href="${a['URL'] || '#'}" target="_blank">View Product</a></li>
    `).join('');
    
    const htmlBody = `<p><strong>Requested items:</strong></p><ul>${itemsHtml}</ul><p>Requested by ${approved_by || name}</p>`;

    const ticketPayload = {
      ticket: {
        subject: subject || 'New Service Catalog Request',
        requester: { name, email }, // Let Zendesk handle user creation/matching
        comment: { html_body: htmlBody },
      },
    };

    console.log("Attempting to create ticket...");
    const ticketResponse = await zendeskApi.post('/tickets.json', ticketPayload);
    const ticket = ticketResponse.data.ticket;
    console.log(`Successfully created ticket ID: ${ticket.id}`);

    // 2. Create asset records for each item and link to the ticket and user
    const createdAssets = [];
    for (const asset of assets) {
      // IMPORTANT: The keys here (e.g., 'name', 'manufacturer') MUST EXACTLY MATCH
      // the 'Field key' in your Zendesk Custom Object definition.
      const customFields = {
        name: asset.Name,
        manufacturer: asset.Manufacturer,
        model_number: asset['Model Number'],
        ticket_id: ticket.id.toString(),
        approved_by: approved_by,
      };

      const assetPayload = {
        custom_object_record: {
          custom_object_fields: customFields,
          relationships: {
            // This key 'assigned_to' must also match your relationship key in Zendesk.
            assigned_to: { data: { id: ticket.requester_id } }
          }
        }
      };
      
      try {
        console.log(`Attempting to create asset record for: ${asset.Name}`);
        const assetResponse = await zendeskApi.post(`/custom_objects/${ZENDESK_ASSET_OBJECT_KEY}/records.json`, assetPayload);
        createdAssets.push(assetResponse.data);
        console.log(`Successfully created asset record for: ${asset.Name}`);
      } catch (assetError) {
        // DEBUGGING: If an asset fails, log the specific error and the data we tried to send.
        console.error(`!!!!!!!! FAILED to create asset record for: ${asset.Name} !!!!!!!!`);
        console.error("Zendesk API Error:", assetError.response ? assetError.response.data : assetError.message);
        console.error("Data Sent:", JSON.stringify(assetPayload, null, 2));
        // We will continue trying to create other assets but will report the overall failure.
        throw new Error(`Failed to create asset record for ${asset.Name}. Check the logs.`);
      }
    }

    res.status(201).json({ ticket, assets: createdAssets });

  } catch (error) {
    // This will catch errors from both ticket and asset creation.
    console.error('Error in the /api/ticket POST endpoint:', error.message);
    res.status(500).json({ error: 'Failed to process request.', details: error.message });
  }
});

/**
 * Endpoint to get all asset records associated with a given ticket_id.
 */
app.get('/api/ticket', async (req, res) => {
    const { ticket_id } = req.query;
    if (!ticket_id) {
        return res.status(400).json({ error: 'Missing ticket_id query parameter.' });
    }

    try {
        // More efficient: Use the API to filter instead of fetching all records.
        // This assumes you have a custom field on your asset object with the key 'ticket_id'.
        const response = await zendeskApi.get(`/custom_objects/${ZENDESK_ASSET_OBJECT_KEY}/records.json?filter[field]=ticket_id&filter[value]=${ticket_id}`);
        res.json({ assets: response.data.custom_object_records || [] });
    } catch (error) {
        console.error('Error fetching ticket assets:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to fetch ticket assets.', details: error.response ? error.response.data : error.message });
    }
});


// --- Start Server ---
app.listen(port, () => {
  console.log(`Zendesk Catalog + Asset Proxy is up and listening on port ${port}`);
  if (!ZENDESK_SUBDOMAIN || !ZENDESK_API_TOKEN || !ZENDESK_USER_EMAIL || !GOOGLE_CREDS_JSON || !GOOGLE_SHEET_URL) {
    console.warn('WARNING: One or more environment variables are not set. The application may not function correctly.');
  }
});

