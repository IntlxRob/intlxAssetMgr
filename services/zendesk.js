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
 * Creates a ticket and then creates asset records for each item.
 */
async function createTicketAndAssets(body) {
  const { assets, name, email, subject, approved_by } = body;
  if (!assets || !Array.isArray(assets) || assets.length === 0) {
    throw new Error('Missing or invalid assets list.');
  }

  const itemsHtml = assets.map(a =>
    `<li><strong>${a['Name']}</strong><br/><small>${a['Manufacturer']} / ${a['Model Number']}</small></li>`
  ).join('');

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
        relationships: {
          assigned_to: {
            data: { id: ticket.requester_id }
          }
        }
      }
    };

    try {
      console.log(`Attempting to create asset record for: ${asset.Name}`);
      const assetResponse = await zendeskApi.post(`/custom_objects/${ZENDESK_ASSET_OBJECT_KEY}/records.json`, assetPayload);
      createdAssets.push(assetResponse.data);
      console.log(`Successfully created asset record. New asset ID: ${assetResponse.data.custom_object_record.id}`);
    } catch (assetError) {
      console.error(`FAILED to create asset record for: ${asset.Name}`);
      console.error("Zendesk API Error:", assetError.response ? assetError.response.data : assetError.message);
      throw new Error(`Failed to create asset record for ${asset.Name}.`);
    }
  }

  return { ticket, assets: createdAssets };
}

/**
 * Gets all asset records associated with a given user ID by manually filtering.
 */
async function getUserAssets(userId) {
  const requestUrl = `/custom_objects/${ZENDESK_ASSET_OBJECT_KEY}/records.json`;
  console.log(`Fetching ALL asset records from Zendesk...`);

  const response = await zendeskApi.get(requestUrl);
  const allRecords = response.data.custom_object_records || [];

  const matchingRecords = allRecords.filter(record =>
    record.custom_object_fields?.assigned_to === userId.toString()
  );

  console.log(`Filtered ${matchingRecords.length} assets assigned to user ID ${userId}.`);
  return matchingRecords;
}

/**
 * Updates an asset record by ID.
 */
async function updateAsset(assetId, fieldsToUpdate) {
  const payload = {
    custom_object_record: {
      custom_object_fields: fieldsToUpdate
      // Add relationship updates here if needed
    }
  };
  try {
    const response = await zendeskApi.patch(`/custom_objects/${ZENDESK_ASSET_OBJECT_KEY}/records/${assetId}.json`, payload);
    return response.data;
  } catch (error) {
    console.error(`Failed to update asset ${assetId}:`, error.response ? error.response.data : error.message);
    throw new Error(`Failed to update asset: ${error.message}`);
  }
}

/**
 * Creates a new asset record in Zendesk.
 */
async function createAsset(assetData) {
  const customFields = {
    asset_name: assetData.asset_name,
    manufacturer: assetData.manufacturer,
    model_number: assetData.model_number,
    serial_number: assetData.serial_number,
    warranty_expiration: assetData.warranty_expiration,
    purchase_date: assetData.purchase_date,
    approved_by: assetData.approved_by,
    status: assetData.status
  };

  const assetPayload = {
    custom_object_record: {
      custom_object_fields: customFields
    }
  };

  try {
    const response = await zendeskApi.post(`/custom_objects/${ZENDESK_ASSET_OBJECT_KEY}/records.json`, assetPayload);
    return response.data;
  } catch (error) {
    console.error("Error creating asset in Zendesk:", error.response ? error.response.data : error.message);
    throw new Error(error.message);
  }
}

module.exports = {
  createTicketAndAssets,
  getUserAssets,
  updateAsset,
  createAsset
};
