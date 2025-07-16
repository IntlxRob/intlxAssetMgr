// services/googleSheets.js
// This file contains all the logic for interacting with the Google Sheets API.

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// --- CONFIGURATION ---
const GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL;
const GOOGLE_CREDS_JSON = process.env.GOOGLE_CREDS_JSON;

/**
 * Fetches and parses the catalog from the configured Google Sheet.
 * @returns {Array} - An array of catalog item objects.
 */
async function getCatalog() {
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
    if (!sheetIdMatch || !sheetIdMatch[1]) {
        throw new Error('Invalid Google Sheet URL. Could not extract Sheet ID.');
    }

    const doc = new GoogleSpreadsheet(sheetIdMatch[1], serviceAccountAuth);

    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    return rows.map(row => row.toObject());
}

module.exports = {
    getCatalog,
};
