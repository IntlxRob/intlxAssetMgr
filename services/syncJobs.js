// services/syncJobs.js
// Optimized background sync jobs with rate limiting and incremental updates
// FIXED: Corrected timestamp handling for ticket sync

const cron = require('node-cron');
const axios = require('axios');
const db = require('../db');
const pool = db.getPool();

// ============================================
// CONFIGURATION
// ============================================

const SYNC_CONFIG = {
  schedules: {
    tickets: '*/5 * * * *',
    organizations: '0 */1 * * *',
    agents: '0 */1 * * *',
    groups: '0 */1 * * *'
  },
  rateLimits: {
    requestsPerMinute: 700,
    delayBetweenRequests: 7000,
    maxRetries: 3,
    retryDelay: 10000
  },
  batchSizes: {
    tickets: 100,
    organizations: 100,
    agents: 100,
    groups: 100
  }
};

const ZENDESK_CONFIG = {
  subdomain: process.env.ZENDESK_SUBDOMAIN,
  email: process.env.ZENDESK_EMAIL,
  token: process.env.ZENDESK_API_TOKEN
};

const ZENDESK_API_BASE = `https://${ZENDESK_CONFIG.subdomain}.zendesk.com/api/v2`;
const ZENDESK_AUTH = Buffer.from(`${ZENDESK_CONFIG.email}/token:${ZENDESK_CONFIG.token}`).toString('base64');

// ============================================
// UTILITY FUNCTIONS
// ============================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function makeZendeskRequest(url, retryCount = 0) {
  try {
    console.log(`📄 Fetching: ${url}`);
    
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Basic ${ZENDESK_AUTH}`,
        'Content-Type': 'application/json'
      }
    });
    
    const delay = SYNC_CONFIG.rateLimits.delayBetweenRequests;
    console.log(`⏳ Waiting ${delay}ms (rate limit protection)...`);
    await sleep(delay);
    
    return response.data;
    
  } catch (error) {
    if (error.response?.status === 429 && retryCount < SYNC_CONFIG.rateLimits.maxRetries) {
      const retryAfter = parseInt(error.response.headers['retry-after'] || '60') * 1000;
      console.log(`⚠️  Rate limited! Retrying after ${retryAfter}ms... (Attempt ${retryCount + 1}/${SYNC_CONFIG.rateLimits.maxRetries})`);
      await sleep(retryAfter);
      return makeZendeskRequest(url, retryCount + 1);
    }
    throw error;
  }
}

// ============================================
// SYNC STATUS MANAGEMENT
// ============================================

async function getSyncStatus(resourceType) {
  try {
    const result = await pool.query(
      'SELECT * FROM sync_status WHERE entity_type = $1',  
      [resourceType]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error(`Error getting sync status for ${resourceType}:`, error.message);
    return null;
  }
}

async function updateSyncStatus(resourceType, status, error = null, recordsSynced = 0) {
  try {
    await pool.query(`
      INSERT INTO sync_status (entity_type, last_sync_at, status, error_message, records_synced, updated_at)  
      VALUES ($1, NOW(), $2, $3, $4, NOW())
      ON CONFLICT (entity_type) 
      DO UPDATE SET
        last_sync_at = NOW(), 
        status = $2,
        error_message = $3,
        records_synced = EXCLUDED.records_synced + $4,
        updated_at = NOW()  
    `, [resourceType, status, error, recordsSynced]);
  } catch (err) {
    console.error(`Error updating sync status for ${resourceType}:`, err.message);
  }
}

// ============================================
// TICKET SYNC (FIXED TIMESTAMP HANDLING)
// ============================================

async function syncTickets() {
  console.log('\n🎫 Starting ticket sync...');
  
  try {
    const status = await getSyncStatus('tickets');
    
    // FIX: Properly handle the timestamp
    let startTime;
    if (status && status.last_sync_at) {
  const lastUpdate = new Date(status.last_sync_at);
      startTime = Math.floor(lastUpdate.getTime() / 1000); // Convert to seconds
    } else {
      // Default to 90 days ago
      startTime = Math.floor((Date.now() - (90 * 24 * 60 * 60 * 1000)) / 1000);
    }
    
    console.log(`📅 Last sync: ${status?.last_sync_at || 'Never'}`);
    console.log(`⏰ Using start_time: ${startTime} (${new Date(startTime * 1000).toISOString()})`);
    
    await updateSyncStatus('tickets', 'syncing');
    
    let allTickets = [];
    let page = 1;
    let hasMore = true;
    
    while (hasMore && page <= 50) {
      // FIX: Use the corrected timestamp
      const url = `${ZENDESK_API_BASE}/incremental/tickets.json?start_time=${startTime}&per_page=${SYNC_CONFIG.batchSizes.tickets}`;
      console.log(`📄 Fetching incremental page ${page}...`);
      
      const data = await makeZendeskRequest(url);
      
      if (data.tickets && data.tickets.length > 0) {
        allTickets.push(...data.tickets);
        console.log(`✅ Retrieved ${data.tickets.length} items (Total: ${allTickets.length})`);
        
        hasMore = !data.end_of_stream;
        page++;
      } else {
        hasMore = false;
      }
    }
    
    console.log(`📦 Total tickets fetched: ${allTickets.length}`);
    
    if (allTickets.length > 0) {
      for (const ticket of allTickets) {
        try {
          await pool.query(`
  INSERT INTO tickets (
    id, subject, description, status, priority, request_type,
    created_at, updated_at, requester_id, assignee_id,
    organization_id, group_id, tags, custom_fields
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb)
  ON CONFLICT (id) DO UPDATE SET
    subject = EXCLUDED.subject,
    description = EXCLUDED.description,
    status = EXCLUDED.status,
    priority = EXCLUDED.priority,
    request_type = EXCLUDED.request_type,
    updated_at = EXCLUDED.updated_at,
    assignee_id = EXCLUDED.assignee_id,
    group_id = EXCLUDED.group_id,
    tags = EXCLUDED.tags,
    custom_fields = EXCLUDED.custom_fields
`, [
  ticket.id,
  ticket.subject,
  ticket.description,
  ticket.status,
  ticket.priority,
  ticket.type,
  ticket.created_at,
  ticket.updated_at,
  ticket.requester_id,
  ticket.assignee_id,
  ticket.organization_id,
  ticket.group_id,
  JSON.stringify(ticket.tags),
  JSON.stringify(ticket.custom_fields)
]);
        } catch (err) {
          console.error(`Error upserting ticket ${ticket.id}:`, err.message);
        }
      }
    }
    
    await updateSyncStatus('tickets', 'success', null, allTickets.length);
    console.log(`✅ Ticket sync completed: ${allTickets.length} synced`);
    
  } catch (error) {
    console.error('❌ Ticket sync failed:', error.message);
    await updateSyncStatus('tickets', 'error', error.message);
  }
}

// ============================================
// ORGANIZATION SYNC
// ============================================

async function syncOrganizations() {
  console.log('\n🏢 Starting organization sync...');
  
  try {
    await updateSyncStatus('organizations', 'syncing');
    
    let allOrganizations = [];
    let page = 1;
    let hasMore = true;
    
    while (hasMore) {
      const url = `${ZENDESK_API_BASE}/organizations.json?per_page=${SYNC_CONFIG.batchSizes.organizations}&page=${page}`;
      const data = await makeZendeskRequest(url);
      
      if (data.organizations && data.organizations.length > 0) {
        allOrganizations.push(...data.organizations);
        console.log(`✅ Retrieved ${data.organizations.length} organizations (Total: ${allOrganizations.length})`);
        hasMore = data.next_page !== null;
        page++;
      } else {
        hasMore = false;
      }
    }
    
    if (allOrganizations.length > 0) {
      for (const org of allOrganizations) {
        try {
          await pool.query(`
            INSERT INTO organizations (
              id, name, created_at, updated_at, domain_names, details, notes, tags
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              updated_at = EXCLUDED.updated_at,
              domain_names = EXCLUDED.domain_names,
              details = EXCLUDED.details,
              notes = EXCLUDED.notes,
              tags = EXCLUDED.tags
          `, [
            org.id,
            org.name,
            org.created_at,
            org.updated_at,
            JSON.stringify(org.domain_names),
            org.details,
            org.notes,
            JSON.stringify(org.tags)
          ]);
        } catch (err) {
          console.error(`Error upserting organization ${org.id}:`, err.message);
        }
      }
    }
    
    await updateSyncStatus('organizations', 'success', null, allOrganizations.length);
    console.log(`✅ Organization sync completed: ${allOrganizations.length} synced`);
    
  } catch (error) {
    console.error('❌ Organization sync failed:', error.message);
    await updateSyncStatus('organizations', 'error', error.message);
  }
}

// ============================================
// AGENT SYNC
// ============================================

async function syncAgents() {
  console.log('\n👤 Starting agent sync...');
  
  try {
    await updateSyncStatus('agents', 'syncing');
    
    let allAgents = [];
    let page = 1;
    let hasMore = true;
    
    while (hasMore) {
      const url = `${ZENDESK_API_BASE}/users.json?role[]=agent&role[]=admin&per_page=${SYNC_CONFIG.batchSizes.agents}&page=${page}`;
      const data = await makeZendeskRequest(url);
      
      if (data.users && data.users.length > 0) {
        allAgents.push(...data.users);
        console.log(`✅ Retrieved ${data.users.length} agents (Total: ${allAgents.length})`);
        hasMore = data.next_page !== null;
        page++;
      } else {
        hasMore = false;
      }
    }
    
    if (allAgents.length > 0) {
      for (const agent of allAgents) {
        try {
          await pool.query(`
            INSERT INTO agents (
              id, name, email, role, created_at, updated_at, last_login_at, active, suspended, tags
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              email = EXCLUDED.email,
              role = EXCLUDED.role,
              updated_at = EXCLUDED.updated_at,
              last_login_at = EXCLUDED.last_login_at,
              active = EXCLUDED.active,
              suspended = EXCLUDED.suspended,
              tags = EXCLUDED.tags
          `, [
            agent.id,
            agent.name,
            agent.email,
            agent.role,
            agent.created_at,
            agent.updated_at,
            agent.last_login_at,
            agent.active,
            agent.suspended,
            JSON.stringify(agent.tags)
          ]);
        } catch (err) {
          console.error(`Error upserting agent ${agent.id}:`, err.message);
        }
      }
    }
    
    await updateSyncStatus('agents', 'success', null, allAgents.length);
    console.log(`✅ Agent sync completed: ${allAgents.length} synced`);
    
  } catch (error) {
    console.error('❌ Agent sync failed:', error.message);
    await updateSyncStatus('agents', 'error', error.message);
  }
}

// ============================================
// GROUP SYNC
// ============================================

async function syncGroups() {
  console.log('\n👥 Starting group sync...');
  
  try {
    await updateSyncStatus('groups', 'syncing');
    
    let allGroups = [];
    let page = 1;
    let hasMore = true;
    
    while (hasMore) {
      const url = `${ZENDESK_API_BASE}/groups.json?per_page=${SYNC_CONFIG.batchSizes.groups}&page=${page}`;
      const data = await makeZendeskRequest(url);
      
      if (data.groups && data.groups.length > 0) {
        allGroups.push(...data.groups);
        console.log(`✅ Retrieved ${data.groups.length} groups (Total: ${allGroups.length})`);
        hasMore = data.next_page !== null;
        page++;
      } else {
        hasMore = false;
      }
    }
    
    if (allGroups.length > 0) {
      for (const group of allGroups) {
        try {
          await pool.query(`
            INSERT INTO groups (
              id, name, created_at, updated_at, deleted
            ) VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              updated_at = EXCLUDED.updated_at,
              deleted = EXCLUDED.deleted
          `, [
            group.id,
            group.name,
            group.created_at,
            group.updated_at,
            group.deleted
          ]);
        } catch (err) {
          console.error(`Error upserting group ${group.id}:`, err.message);
        }
      }
    }
    
    await updateSyncStatus('groups', 'success', null, allGroups.length);
    console.log(`✅ Group sync completed: ${allGroups.length} synced`);
    
  } catch (error) {
    console.error('❌ Group sync failed:', error.message);
    await updateSyncStatus('groups', 'error', error.message);
  }
}

// ============================================
// SCHEDULER
// ============================================

function scheduleSync() {
  console.log('🚀 Scheduling background sync jobs...');
  
  cron.schedule(SYNC_CONFIG.schedules.tickets, () => {
    console.log('\n⏰ Running scheduled ticket sync...');
    syncTickets().catch(err => console.error('Scheduled ticket sync error:', err));
  });
  
  cron.schedule(SYNC_CONFIG.schedules.organizations, () => {
    console.log('\n⏰ Running scheduled organization sync...');
    syncOrganizations().catch(err => console.error('Scheduled organization sync error:', err));
  });
  
  cron.schedule(SYNC_CONFIG.schedules.agents, () => {
    console.log('\n⏰ Running scheduled agent sync...');
    syncAgents().catch(err => console.error('Scheduled agent sync error:', err));
  });
  
  cron.schedule(SYNC_CONFIG.schedules.groups, () => {
    console.log('\n⏰ Running scheduled group sync...');
    syncGroups().catch(err => console.error('Scheduled group sync error:', err));
  });
  
  console.log('✅ All sync jobs scheduled successfully');
  console.log('📅 Schedules:');
  console.log(`   - Tickets: ${SYNC_CONFIG.schedules.tickets} (every 5 minutes)`);
  console.log(`   - Organizations: ${SYNC_CONFIG.schedules.organizations} (every hour)`);
  console.log(`   - Agents: ${SYNC_CONFIG.schedules.agents} (every hour)`);
  console.log(`   - Groups: ${SYNC_CONFIG.schedules.groups} (every hour)`);
  
  const initialDelay = Math.floor(Math.random() * 10000) + 10000;
  console.log(`⏳ Initial sync will run in ${initialDelay/1000} seconds...`);
  
  setTimeout(() => {
    console.log('\n🎬 Running initial sync...');
    Promise.all([
      syncOrganizations(),
      syncAgents(),
      syncGroups()
    ]).then(() => {
      console.log('✅ Initial sync of orgs/agents/groups complete');
      return syncTickets();
    }).then(() => {
      console.log('✅ Initial ticket sync complete');
    }).catch(err => {
      console.error('❌ Initial sync error:', err);
    });
  }, initialDelay);
}

module.exports = {
  scheduleSync,
  syncTickets,
  syncOrganizations,
  syncAgents,
  syncGroups,
  getSyncStatus
};
