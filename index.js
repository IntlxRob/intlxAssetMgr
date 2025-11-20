require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const apiRoutes = require('./routes/api');
const app = express();
const metrics = require('./routes/metrics');

// ✨ NEW: Add these 3 imports for analytics
const analyticsRoutes = require('./routes/analytics');
const { initRedis } = require('./middleware/cache');
const { scheduleSync } = require('./services/syncJobs');

const PORT = process.env.PORT || 3000;

// CORS Configuration - Allow Zendesk app domain
const allowedOrigins = [
  'http://localhost:4567',                      // Local development
  'http://localhost:8000',
  /^https:\/\/\d+\.apps\.zdusercontent\.com$/,  // Matches ANY Zendesk app
  'https://1184027.apps.zdusercontent.com',     // Ticket IQ app
  'https://1179764.apps.zdusercontent.com',     // Agent Assist app
  'https://intlxsolutions.zendesk.com',          // Your Zendesk instance
  'https://support.intlxsolutions.com', // intlx Help Center Domain
  'https://www.knowi.com', // knowi Integration
  null
];

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like Postman, curl, or server-to-server, or local files)
    if (!origin || origin === 'null') return callback(null, true); 
    
    // Check if origin matches any allowed origin (string or regex)
    const isAllowed = allowedOrigins.some(allowed => {
      if (allowed instanceof RegExp) {
        return allowed.test(origin);
      }
      return allowed === origin;
    });
    
    if (isAllowed) {
      console.log(`✅ CORS allowed origin: ${origin}`);
      callback(null, true);
    } else {
      console.log(`❌ CORS blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));  // Increase JSON body size limit
app.use(express.urlencoded({ extended: true, limit: '50mb' }));  // Also handle URL-encoded data
app.use(cookieParser());

// ✨ NEW: Initialize Redis for analytics caching (add right here)
(async () => {
    try {
        await initRedis();
        console.log('✅ Redis initialized for analytics');
    } catch (error) {
        console.warn('⚠️  Redis unavailable (analytics will work without caching):', error.message);
    }
})();

app.use('/api', apiRoutes);
app.use('/hooks/metrics', metrics);
app.use('/admin/metrics', require('./routes/metricsBackfill'));

// ✨ NEW: Add analytics routes here
app.use('/api/analytics', analyticsRoutes);

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

// ✨ NEW: Start analytics sync scheduler (add right before app.listen)
if (process.env.ENABLE_ANALYTICS_SYNC !== 'false') {
    scheduleSync();
    console.log('✅ Analytics sync scheduler started');
}

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log('[Server] Ready to initialize presence system...');
});