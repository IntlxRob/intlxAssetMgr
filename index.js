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
const verifyZendeskToken = require('./middleware/verifyZendeskToken');
// Not a replacement for the above. verifyZendeskToken compares a static secret
// that Zendesk's WEBHOOKS send; this verifies a short-lived signed JWT that
// Zendesk's APP PROXY sends. Different callers, different mechanisms.
const verifyZafJwt = require('./middleware/verifyZafJwt');
const { logAuthStatus } = require('./services/zendeskAuth');

// Confirms the Zendesk credential works and names the acting identity at boot.
// Never throws - a failure logs loudly rather than stopping the API serving.
logAuthStatus();
const { scheduleSync } = require('./services/syncJobs');

const PORT = process.env.PORT || 3000;

// CORS Configuration - Allow Zendesk app domain
const allowedOrigins = [
  'http://localhost:4567',                      // Local development (ZAT)
  'http://localhost:8000',
  'http://localhost:5173',                      // Vite dev server (Ticket IQ rebuild)
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

// -------------------------------------------------------------------------
// Everything under /api requires a signed request.
//
// Until 2026-11-02 it required nothing: a plain curl to
// /api/analytics/tickets/paginated returned 200 with ticket data. Roughly
// fifty read routes and a dozen write routes were open to anyone holding the
// hostname.
//
// This ONE mount also covers /api/analytics, mounted further down — Express
// runs prefix-matching middleware in declaration order, so a request to
// /api/analytics/... passes through here first. Mounting it twice would verify
// the same token twice.
//
// Requests arrive either from Zendesk's app proxy (signed by it, from Zendesk
// IP ranges) or from the vite dev server (which signs its own with the same
// secret). The CORS allowlist is no longer what admits app traffic, because
// proxied requests are not browser requests.
// -------------------------------------------------------------------------

/**
 * Paths under /api that stay open.
 *
 * Only the health endpoint, and only because a platform health check that
 * starts returning 401 makes Render consider the service broken and the deploy
 * failed — an outage caused by the fix.
 *
 * Keep this at one entry. An exemption list is the shape that grows until it
 * is the rule rather than the exception, and this codebase has four recorded
 * cases of a control that existed and did not run. If a second path ever needs
 * exempting, move the health check outside /api instead.
 */
const OPEN_API_PATHS = new Set([
    '/api/analytics/health'
]);

app.use('/api', (req, res, next) => {
    // originalUrl rather than req.path: inside a mounted middleware req.url is
    // rewritten relative to the mount point, and comparing full paths here is
    // less subtle than relying on that.
    const pathOnly = req.originalUrl.split('?')[0];
    if (OPEN_API_PATHS.has(pathOnly)) return next();
    return verifyZafJwt(req, res, next);
});

app.use('/api', apiRoutes);
app.use('/hooks/metrics', verifyZendeskToken, metrics);
// /ping is a harmless health check; every other route under this mount
// writes to Zendesk, so it needs the shared secret.
const protectMetricsAdmin = (req, res, next) =>
  req.path === '/ping' ? next() : verifyZendeskToken(req, res, next);

app.use('/admin/metrics', protectMetricsAdmin, require('./routes/metricsBackfill'));

// ✨ NEW: Add analytics routes here
app.use('/api/analytics', analyticsRoutes);

app.get('/', (req, res) => {
  res.send('Backend API is running');
});




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
        // cleanupPresenceSubscriptions() used to be called here. It was never
        // defined anywhere in this repo, so this line threw on every SIGTERM
        // and SIGINT — which meant the clearInterval() below never ran and
        // graceful shutdown never completed. Every deploy took this path.
        //
        // Nothing replaces it, because there is nothing to tear down: the
        // function that would have created those subscriptions
        // (initializeDirectPresenceSubscriptions) was equally undefined and
        // equally never ran.

        // Draining the pool is what a graceful shutdown is actually for, and
        // it is what the throw above has been preventing. Lazily required and
        // separately guarded so a shape change in ./db cannot reintroduce the
        // same failure.
        try {
            const db = require('./db');
            if (db && typeof db.getPool === 'function') {
                await db.getPool().end();
                console.log('[Server] Postgres pool drained');
            }
        } catch (dbError) {
            console.error(
                '[Server] Pool drain failed:',
                dbError && dbError.message ? dbError.message : dbError
            );
        }

        console.log('[Server] Cleanup completed');
    } catch (error) {
        console.error('[Server] Cleanup error:', error);
    }
}


// ✨ NEW: Start analytics sync scheduler (add right before app.listen)
if (process.env.ENABLE_ANALYTICS_SYNC !== 'false') {
    scheduleSync();
    console.log('✅ Analytics sync scheduler started');
}

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});