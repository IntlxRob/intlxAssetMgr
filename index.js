require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const apiRoutes = require('./routes/api');
const app = express();

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use('/api', apiRoutes);

app.get('/', (req, res) => {
  res.send('Backend API is running');
});

// ENHANCED: Initialize both subscriptions AND cache data
async function initializeServer() {
    try {
        console.log('[Server] Starting presence system initialization...');
        
        setTimeout(async () => {
            try {
                // Import the cache function
                const { initializePresenceCache } = require('./routes/api');
                
                // Step 1: Initialize cache data first
                await initializePresenceCache();
                console.log('[Server] ✅ Presence cache initialized');
                
                // Step 2: Then set up subscriptions (your existing code)
                await initializeDirectPresenceSubscriptions();
                console.log('[Server] ✅ Presence subscriptions initialized');
                
            } catch (error) {
                console.error('[Server] ❌ Failed to initialize presence system:', error);
                console.log('[Server] Will fallback to on-demand initialization');
            }
        }, 5000);
        
    } catch (error) {
        console.error('[Server] Error during initialization:', error);
    }
}

// ADD THIS: Cache initialization function
async function initializePresenceCache() {
    try {
        // Import your cache initialization function from your routes
        const { refreshAgentCache } = require('./routes/api');
        await refreshAgentCache();
        console.log('[Server] Presence cache populated with initial data');
    } catch (error) {
        console.error('[Server] Failed to initialize presence cache:', error);
        throw error;
    }
}

// ADD THIS: Periodic cache refresh
function startCacheRefreshTimer() {
    // Refresh cache every 2 minutes as backup
    setInterval(async () => {
        try {
            await initializePresenceCache();
            console.log('[Server] Background cache refresh completed');
        } catch (error) {
            console.error('[Server] Background cache refresh failed:', error);
        }
    }, 120000); // 2 minutes
}

// Enhanced cleanup
process.on('SIGTERM', async () => {
    console.log('[Server] SIGTERM received, cleaning up...');
    await cleanup();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('[Server] SIGINT received, cleaning up...');
    await cleanup();
    process.exit(0);
});

// ADD THIS: Comprehensive cleanup
async function cleanup() {
    try {
        await cleanupPresenceSubscriptions();
        // Clear any timers
        clearInterval(global.cacheRefreshTimer);
        console.log('[Server] Cleanup completed');
    } catch (error) {
        console.error('[Server] Cleanup error:', error);
    }
}

// Start the initialization
initializeServer();

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log('[Server] Ready to initialize presence system...');
});