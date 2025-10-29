// middleware/cache.js - Redis Cache Middleware
const redis = require('redis');

let redisClient = null;
let isRedisAvailable = false;

/**
 * Initialize Redis client
 */
async function initRedis() {
    if (!process.env.REDIS_URL) {
        console.warn('⚠️ REDIS_URL not configured - caching disabled');
        return;
    }

    try {
        redisClient = redis.createClient({
            url: process.env.REDIS_URL,
            socket: {
                reconnectStrategy: (retries) => {
                    if (retries > 10) {
                        console.error('❌ Redis reconnection failed after 10 attempts');
                        return new Error('Max reconnection attempts reached');
                    }
                    return Math.min(retries * 100, 3000);
                }
            }
        });

        redisClient.on('error', (err) => {
            console.error('❌ Redis Client Error:', err);
            isRedisAvailable = false;
        });

        redisClient.on('connect', () => {
            console.log('✅ Redis connected');
            isRedisAvailable = true;
        });

        redisClient.on('ready', () => {
            console.log('✅ Redis ready');
            isRedisAvailable = true;
        });

        await redisClient.connect();
    } catch (error) {
        console.error('❌ Redis initialization failed:', error);
        isRedisAvailable = false;
    }
}

/**
 * Cache middleware for Express routes
 * @param {number} ttl - Time to live in seconds (default: 300 = 5 minutes)
 * @returns {Function} Express middleware
 */
function cacheMiddleware(ttl = 300) {
    return async (req, res, next) => {
        // Skip caching if Redis not available or if explicitly disabled
        if (!isRedisAvailable || req.query.nocache === 'true') {
            return next();
        }

        // Generate cache key from route and query params
        const cacheKey = `analytics:${req.path}:${JSON.stringify(req.query)}`;

        try {
            // Try to get cached data
            const cachedData = await redisClient.get(cacheKey);
            
            if (cachedData) {
                console.log(`✅ Cache HIT: ${cacheKey}`);
                return res.json(JSON.parse(cachedData));
            }

            console.log(`❌ Cache MISS: ${cacheKey}`);

            // Store original res.json function
            const originalJson = res.json.bind(res);

            // Override res.json to cache the response
            res.json = (data) => {
                // Cache the response
                redisClient.setEx(cacheKey, ttl, JSON.stringify(data))
                    .catch(err => console.error('❌ Cache write error:', err));

                // Send the response
                return originalJson(data);
            };

            next();
        } catch (error) {
            console.error('❌ Cache middleware error:', error);
            next();
        }
    };
}

/**
 * Clear cache by pattern
 * @param {string} pattern - Redis key pattern (e.g., 'analytics:*')
 */
async function clearCache(pattern = 'analytics:*') {
    if (!isRedisAvailable) {
        return { cleared: 0, message: 'Redis not available' };
    }

    try {
        const keys = await redisClient.keys(pattern);
        if (keys.length > 0) {
            await redisClient.del(keys);
            console.log(`✅ Cleared ${keys.length} cache keys`);
            return { cleared: keys.length };
        }
        return { cleared: 0 };
    } catch (error) {
        console.error('❌ Cache clear error:', error);
        throw error;
    }
}

/**
 * Get cache statistics
 */
async function getCacheStats() {
    if (!isRedisAvailable) {
        return { available: false };
    }

    try {
        const info = await redisClient.info('stats');
        const keys = await redisClient.keys('analytics:*');
        
        return {
            available: true,
            totalKeys: keys.length,
            info: info
        };
    } catch (error) {
        console.error('❌ Error getting cache stats:', error);
        return { available: false, error: error.message };
    }
}

module.exports = {
    initRedis,
    cacheMiddleware,
    clearCache,
    getCacheStats,
    isRedisAvailable: () => isRedisAvailable
};
