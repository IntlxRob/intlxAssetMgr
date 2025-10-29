// db.js - PostgreSQL Connection Helper
const { Pool } = require('pg');

let pool = null;

/**
 * Get or create PostgreSQL connection pool
 * @returns {Pool} PostgreSQL connection pool
 */
function getPool() {
    if (!pool) {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production' ? {
                rejectUnauthorized: false
            } : false,
            max: 20, // Maximum connections in pool
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 2000,
        });

        pool.on('error', (err) => {
            console.error('❌ Unexpected database error:', err);
        });

        pool.on('connect', () => {
            console.log('✅ Database connection established');
        });
    }

    return pool;
}

/**
 * Execute a query with error handling
 * @param {string} text - SQL query text
 * @param {Array} params - Query parameters
 * @returns {Promise<Object>} Query result
 */
async function query(text, params) {
    const start = Date.now();
    try {
        const result = await getPool().query(text, params);
        const duration = Date.now() - start;
        
        if (duration > 1000) {
            console.warn(`⚠️ Slow query (${duration}ms):`, text.substring(0, 100));
        }
        
        return result;
    } catch (error) {
        console.error('❌ Database query error:', error);
        throw error;
    }
}

/**
 * Close the database pool
 */
async function close() {
    if (pool) {
        await pool.end();
        pool = null;
        console.log('✅ Database pool closed');
    }
}

module.exports = {
    getPool,
    query,
    close
};
