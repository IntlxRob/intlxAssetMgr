// ============================================
// 🚀 OPTIMIZED SYNC JOBS FOR ZENDESK
// ============================================
// This version handles Zendesk's strict rate limits:
// - Incremental API: 10 requests/minute
// - Regular API: 700 requests/minute
// ============================================

const axios = require('axios');
const db = require('../db'); // Use existing db.js

// ============================================
// CONFIGURATION
// ============================================
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;

// Rate limit settings for INCREMENTAL API
const INCREMENTAL_DELAY_MS = 7000; // 7 seconds between incremental calls (safer than 6)
const INCREMENTAL_MAX_RETRIES = 5;
const INCREMENTAL_BACKOFF_BASE = 10000; // Start with 10 second backoff

// Rate limit settings for REGULAR API
const REGULAR_DELAY_MS = 200; // 200ms between regular calls
const REGULAR_MAX_RETRIES = 3;

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay
 */
function getBackoffDelay(attempt, baseDelay = INCREMENTAL_BACKOFF_BASE) {
  return baseDelay * Math.pow(2, attempt);
}

/**
 * Parse rate limit headers from Zendesk response
 */
function parseRateLimitHeaders(headers) {
  const remaining = parseInt(headers['x-rate-limit-remaining'] || 700);
  const limit = parseInt(headers['x-rate-limit'] || 700);
  
  // Parse incremental export limits if present
  const incrementalHeader = headers['zendesk-rate-limit-incremental-exports'];
  let incrementalRemaining = 10;
  let incrementalResets = 1;
  
  if (incrementalHeader) {
    const match = incrementalHeader.match(/remaining=(-?\d+)/);
    const resetMatch = incrementalHeader.match(/resets=(\d+)/);
    if (match) incrementalRemaining = parseInt(match[1]);
    if (resetMatch) incrementalResets = parseInt(resetMatch[1]);
  }
  
  return {
    remaining,
    limit,
    incrementalRemaining,
    incrementalResets,
    percentage: (remaining / limit) * 100
  };
}

/**
 * Make a request to Zendesk API with rate limiting and retries
 */
async function zendeskRequest(url, isIncremental = false, attempt = 0) {
  const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString('base64');
  
  try {
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 30000
    });
    
    // Log rate limit status
    const rateLimits = parseRateLimitHeaders(response.headers);
    if (isIncremental) {
      console.log(`[Rate Limit] Incremental API: ${rateLimits.incrementalRemaining} remaining, resets in ${rateLimits.incrementalResets}s`);
    }
    
    return response.data;
    
  } catch (error) {
    if (error.response?.status === 429) {
      const maxRetries = isIncremental ? INCREMENTAL_MAX_RETRIES : REGULAR_MAX_RETRIES;
      
      if (attempt >= maxRetries) {
        console.error(`❌ Max retries (${maxRetries}) reached for ${url}`);
        throw error;
      }
      
      // Get retry-after header or use exponential backoff
      const retryAfter = parseInt(error.response.headers['retry-after'] || 0);
      const backoffDelay = getBackoffDelay(attempt);
      const waitTime = retryAfter ? retryAfter * 1000 : backoffDelay;
      
      console.log(`⏳ Rate limited (429). Waiting ${Math.round(waitTime/1000)}s before retry ${attempt + 1}/${maxRetries}...`);
      await sleep(waitTime);
      
      return zendeskRequest(url, isIncremental, attempt + 1);
    }
    
    console.error(`❌ Zendesk API error (${url}):`, error.message);
    throw error;
  }
}

/**
 * Fetch all pages from Zendesk API with proper rate limiting
 */
async function zendeskFetchAll(endpoint, isIncremental = false) {
  const results = [];
  let nextPage = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/${endpoint}`;
  let pageCount = 0;
  
  while (nextPage) {
    pageCount++;
    console.log(`📄 Fetching page ${pageCount} from ${endpoint}...`);
    
    const data = await zendeskRequest(nextPage, isIncremental);
    
    // Determine which field contains the results
    const resultKey = Object.keys(data).find(key => 
      Array.isArray(data[key]) && !['next_page', 'previous_page', 'count'].includes(key)
    );
    
    if (resultKey && data[resultKey]) {
      results.push(...data[resultKey]);
      console.log(`✅ Retrieved ${data[resultKey].length} items (Total: ${results.length})`);
    }
    
    nextPage = data.next_page || null;
    
    // Apply appropriate delay before next request
    if (nextPage) {
      const delay = isIncremental ? INCREMENTAL_DELAY_MS : REGULAR_DELAY_MS;
      console.log(`⏱️  Waiting ${delay}ms before next request...`);
      await sleep(delay);
    }
  }
  
  return results;
}

/**
 * Fetch all pages from Zendesk incremental API with aggressive rate limiting
 */
async function zendeskFetchIncremental(endpoint, startTime) {
  const results = [];
  let url = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/${endpoint}?start_time=${startTime}`;
  let pageCount = 0;
  let endOfStream = false;
  
  while (url && !endOfStream) {
    pageCount++;
    console.log(`📄 Fetching incremental page ${pageCount}...`);
    
    try {
      const data = await zendeskRequest(url, true); // Mark as incremental
      
      // Determine result key
      const resultKey = Object.keys(data).find(key => 
        Array.isArray(data[key]) && !['next_page', 'previous_page', 'count'].includes(key)
      );
      
      if (resultKey && data[resultKey]) {
        const newItems = data[resultKey];
        results.push(...newItems);
        console.log(`✅ Retrieved ${newItems.length} items (Total: ${results.length})`);
      }
      
      // Check for end of stream
      endOfStream = data.end_of_stream || false;
      
      if (endOfStream) {
        console.log('🏁 Reached end of incremental stream');
        break;
      }
      
      // Get next page
      url = data.next_page || null;
      
      // CRITICAL: Wait 7 seconds between incremental API calls
      if (url && !endOfStream) {
        console.log(`⏳ Waiting ${INCREMENTAL_DELAY_MS}ms (rate limit protection)...`);
        await sleep(INCREMENTAL_DELAY_MS);
      }
      
    } catch (error) {
      if (error.response?.status === 429) {
        console.log('⚠️  Still rate limited after retries. Saving progress and exiting...');
        break;
      }
      throw error;
    }
  }
  
  return results;
}

// ============================================
// SYNC FUNCTIONS
// ============================================

/**
 * Sync Organizations from Zendesk
 */
async function syncOrganizations() {
  console.log('🔄 Starting organizations sync...');
  
  try {
    const organizations = await zendeskFetchAll('organizations.json');
    
    if (organizations.length === 0) {
      console.log('ℹ️  No organizations to sync');
      return { success: true, count: 0 };
    }
    
    // Upsert into database using existing db.js
    const pool = db.getPool();
    const client = await pool.connect();
    
    try {
      for (const org of organizations) {
        await client.query(`
          INSERT INTO organizations (id, name, created_at, updated_at, details, tags)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            updated_at = EXCLUDED.updated_at,
            details = EXCLUDED.details,
            tags = EXCLUDED.tags
        `, [
          org.id,
          org.name,
          org.created_at,
          org.updated_at,
          JSON.stringify(org),
          org.tags || []
        ]);
      }
      
      console.log(`✅ Organizations sync complete: ${organizations.length} records`);
      return { success: true, count: organizations.length };
      
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('❌ Organizations sync failed:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Sync Agents (Users) from Zendesk
 */
async function syncAgents() {
  console.log('🔄 Starting agents sync...');
  
  try {
    const users = await zendeskFetchAll('users.json');
    
    if (users.length === 0) {
      console.log('ℹ️  No agents to sync');
      return { success: true, count: 0 };
    }
    
    // Filter for agents only
    const agents = users.filter(u => u.role === 'agent' || u.role === 'admin');
    
    // Upsert into database using existing db.js
    const pool = db.getPool();
    const client = await pool.connect();
    
    try {
      for (const agent of agents) {
        await client.query(`
          INSERT INTO agents (id, name, email, role, created_at, updated_at, custom_fields)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            email = EXCLUDED.email,
            role = EXCLUDED.role,
            updated_at = EXCLUDED.updated_at,
            custom_fields = EXCLUDED.custom_fields
        `, [
          agent.id,
          agent.name,
          agent.email,
          agent.role,
          agent.created_at,
          agent.updated_at,
          agent.user_fields || {}
        ]);
      }
      
      console.log(`✅ Agents sync complete: ${agents.length} records`);
      return { success: true, count: agents.length };
      
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('❌ Agents sync failed:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Sync Groups from Zendesk
 */
async function syncGroups() {
  console.log('🔄 Starting groups sync...');
  
  try {
    const groups = await zendeskFetchAll('groups.json');
    
    if (groups.length === 0) {
      console.log('ℹ️  No groups to sync');
      return { success: true, count: 0 };
    }
    
    // Upsert into database using existing db.js
    const pool = db.getPool();
    const client = await pool.connect();
    
    try {
      for (const group of groups) {
        await client.query(`
          INSERT INTO groups (id, name, created_at, updated_at)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            updated_at = EXCLUDED.updated_at
        `, [
          group.id,
          group.name,
          group.created_at,
          group.updated_at
        ]);
      }
      
      console.log(`✅ Groups sync complete: ${groups.length} records`);
      return { success: true, count: groups.length };
      
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('❌ Groups sync failed:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Sync Tickets from Zendesk using INCREMENTAL API with aggressive rate limiting
 */
async function syncTickets() {
  console.log('🔄 Starting tickets incremental sync...');
  
  const pool = db.getPool();
  const client = await pool.connect();
  
  try {
    // Check database connection
    await client.query('SELECT 1');
    console.log('✅ Database connection established');
    
    // Get last sync time from database (or use Unix epoch for first sync)
    const lastSyncResult = await client.query(`
      SELECT COALESCE(MAX(EXTRACT(EPOCH FROM updated_at)::bigint), 0) as last_sync
      FROM tickets
    `);
    
    const lastSync = lastSyncResult.rows[0].last_sync || 0;
    const startTime = lastSync > 0 ? lastSync : 1;
    
    console.log(`📅 Last sync: ${lastSync > 0 ? new Date(lastSync * 1000).toISOString() : 'Never'}`);
    console.log(`🕐 Fetching tickets updated since: ${new Date(startTime * 1000).toISOString()}`);
    
    // Fetch tickets using incremental API with rate limiting
    const tickets = await zendeskFetchIncremental('incremental/tickets.json', startTime);
    
    if (tickets.length === 0) {
      console.log('ℹ️  No new tickets to sync');
      return { success: true, count: 0 };
    }
    
    console.log(`💾 Inserting ${tickets.length} tickets into database...`);
    
    // Upsert tickets into database
    let successCount = 0;
    for (const ticket of tickets) {
      try {
        await client.query(`
          INSERT INTO tickets (
            id, subject, description, status, priority,
            requester_id, assignee_id, organization_id, group_id,
            created_at, updated_at, custom_fields, tags, via_channel
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          ON CONFLICT (id) DO UPDATE SET
            subject = EXCLUDED.subject,
            description = EXCLUDED.description,
            status = EXCLUDED.status,
            priority = EXCLUDED.priority,
            requester_id = EXCLUDED.requester_id,
            assignee_id = EXCLUDED.assignee_id,
            organization_id = EXCLUDED.organization_id,
            group_id = EXCLUDED.group_id,
            updated_at = EXCLUDED.updated_at,
            custom_fields = EXCLUDED.custom_fields,
            tags = EXCLUDED.tags,
            via_channel = EXCLUDED.via_channel
        `, [
          ticket.id,
          ticket.subject,
          ticket.description,
          ticket.status,
          ticket.priority,
          ticket.requester_id,
          ticket.assignee_id,
          ticket.organization_id,
          ticket.group_id,
          ticket.created_at,
          ticket.updated_at,
          ticket.custom_fields || {},
          ticket.tags || [],
          ticket.via?.channel || 'unknown'
        ]);
        successCount++;
      } catch (err) {
        console.error(`⚠️  Failed to insert ticket ${ticket.id}:`, err.message);
      }
    }
    
    console.log(`✅ Tickets sync complete: ${successCount}/${tickets.length} records`);
    return { success: true, count: successCount };
    
  } catch (error) {
    console.error('❌ Tickets sync failed:', error);
    return { success: false, error: error.message };
    
  } finally {
    client.release();
  }
}

// ============================================
// MAIN SYNC ORCHESTRATOR
// ============================================

/**
 * Run all sync jobs
 */
async function runAllSyncs() {
  console.log('\n========================================');
  console.log('🚀 Starting Zendesk Sync Process');
  console.log('========================================\n');
  
  const results = {
    organizations: await syncOrganizations(),
    agents: await syncAgents(),
    groups: await syncGroups(),
    tickets: await syncTickets()
  };
  
  console.log('\n========================================');
  console.log('📊 Sync Summary');
  console.log('========================================');
  console.log('Organizations:', results.organizations.success ? `✅ ${results.organizations.count} synced` : `❌ ${results.organizations.error}`);
  console.log('Agents:', results.agents.success ? `✅ ${results.agents.count} synced` : `❌ ${results.agents.error}`);
  console.log('Groups:', results.groups.success ? `✅ ${results.groups.count} synced` : `❌ ${results.groups.error}`);
  console.log('Tickets:', results.tickets.success ? `✅ ${results.tickets.count} synced` : `❌ ${results.tickets.error}`);
  console.log('========================================\n');
  
  return results;
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  syncOrganizations,
  syncAgents,
  syncGroups,
  syncTickets,
  runAllSyncs
};
