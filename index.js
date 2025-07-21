// index.js (Main Server File)
// This file is now responsible for starting the server and loading middleware and routes.

// Simple test route to verify server is running and routes work
app.get('/api/test', (req, res) => {
  console.log('Received request to /api/test');
  res.json({ message: 'API is up and responding!' });
});

const express = require('express');
const cors = require('cors');
const https = require('https');
const apiRoutes = require('./routes/api'); // Import the new routes file

// --- GLOBAL SSL/TLS Fix ---
// This needs to be at the top level to apply to all outgoing requests.
const ciphers = [
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'TLS_AES_128_GCM_SHA256',
    'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-ECDSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES128-GCM-SHA256',
].join(':');
https.globalAgent.options.minVersion = 'TLSv1.2';
https.globalAgent.options.ciphers = ciphers;

const app = express();
const port = process.env.PORT || 3000;

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- ROUTES ---
app.get("/", (req, res) => {
  res.send("Zendesk Catalog + Asset Proxy is up!");
});

// Use the apiRoutes for any path starting with /api
app.use('/api', apiRoutes);

// --- Start Server ---
app.listen(port, () => {
  console.log(`Zendesk Catalog + Asset Proxy is up and listening on port ${port}`);
  if (!process.env.ZENDESK_DOMAIN || !process.env.ZENDESK_API_TOKEN || !process.env.ZENDESK_EMAIL || !process.env.GOOGLE_CREDS_JSON || !process.env.GOOGLE_SHEET_URL) {
    console.warn('WARNING: One or more environment variables are not set. The application may not function correctly.');
  }
});
