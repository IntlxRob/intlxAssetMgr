require('dotenv').config(); // ✅ Loads environment variables from .env

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const apiRoutes = require('./routes/api');
const app = express();

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(cookieParser());

// Mount all API routes on /api
app.use('/api', apiRoutes);

// AUTHENTICATION ROUTES
require('./routes/auth')(app);

// Root route for quick test
app.get('/', (req, res) => {
  res.send('Backend API is running');
});

// Initialize presence subscriptions on server startup
async function initializeServer() {
    try {
        console.log('[Server] Starting presence subscription system...');
        
        // Give the server a moment to fully start
        setTimeout(async () => {
            try {
                await initializeDirectPresenceSubscriptions();
                console.log('[Server] ✅ Presence subscriptions initialized');
            } catch (error) {
                console.error('[Server] ❌ Failed to initialize subscriptions:', error);
                console.log('[Server] Will fallback to polling mode');
            }
        }, 5000); // 5 second delay to ensure server is ready
        
    } catch (error) {
        console.error('[Server] Error during initialization:', error);
    }
}

// Cleanup subscriptions on server shutdown
process.on('SIGTERM', async () => {
    console.log('[Server] SIGTERM received, cleaning up subscriptions...');
    await cleanupPresenceSubscriptions();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('[Server] SIGINT received, cleaning up subscriptions...');
    await cleanupPresenceSubscriptions();
    process.exit(0);
});

// Start the initialization
initializeServer();

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
