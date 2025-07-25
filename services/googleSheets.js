// services/googleSheets.js
// This file contains all the logic for interacting with the Google Sheets API.

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// --- CONFIGURATION ---
const GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL;
const GOOGLE_CREDS_JSON = process.env.GOOGLE_CREDS_JSON;

/**
 * Extracts the spreadsheet ID from a standard Google Sheet URL.
 * @returns {string} - Spreadsheet ID
 */
function getSheetIdFromUrl(url) {
  const match = url.match(/\/d\/([a-zA-Z0-9-_]+)\//);
  if (!match || !match[1]) {
    throw new Error('Invalid Google Sheet URL. Could not extract Sheet ID.');
  }
  return match[1];
}

/**
 * Authenticates and returns a loaded GoogleSpreadsheet instance.
 * @returns {Promise<GoogleSpreadsheet>}
 */
async function getSheetDoc() {
  if (!GOOGLE_CREDS_JSON || !GOOGLE_SHEET_URL) {
    throw new Error('Google Sheets environment variables are not configured.');
  }

  try {
    const creds = JSON.parse(GOOGLE_CREDS_JSON);
    const auth = new JWT({
      email: creds.client_email,
      key: creds.private_key.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const doc = new GoogleSpreadsheet(getSheetIdFromUrl(GOOGLE_SHEET_URL), auth);
    await doc.loadInfo();
    console.log(`✅ Loaded spreadsheet: ${doc.title}`);
    return doc;
  } catch (err) {
    console.error('❌ Error loading Google Sheet:', err.message);
    throw err;
  }
}

/**
 * Fetches and parses the catalog from the first sheet.
 * @returns {Array<Object>} - An array of catalog item objects.
 */
async function getCatalog() {
  const doc = await getSheetDoc();
  const sheet = doc.sheetsByIndex[0];
  const rows = await sheet.getRows();
  return rows.map(row => row.toObject());
}

/**
 * Fetches all assets assigned to the given user_id from the "Assets" sheet.
 * @param {string} userId - The Zendesk user ID.
 * @returns {Array<Object>} - Array of matching asset objects.
 */
async function getUserAssets(userId) {
  const doc = await getSheetDoc();
  const sheet = doc.sheetsByTitle['Assets'];
  if (!sheet) {
    throw new Error('Assets sheet not found in Google Sheet.');
  }

  const rows = await sheet.getRows();
  return rows
    .filter(row => `${row.assigned_user_id}` === `${userId}`)
    .map(row => row.toObject());
}

module.exports = {
  getCatalog,
  getUserAssets,
};
