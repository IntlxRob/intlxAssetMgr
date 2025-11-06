// scripts/backfill-metrics.js
// One-time script to backfill metrics for all existing tickets

const axios = require('axios');
const db = require('../db');
const pool = db.getPool();

const ZENDESK_CONFIG = {
  subdomain: process.env.ZENDESK_SUBDOMAIN,
  email: process.env.ZENDESK_EMAIL,
  token: process.env.ZENDESK_API_TOKEN
};

const ZENDESK_API_BASE = `https://${ZENDESK_CONFIG.subdomain}.zendesk.com/api/v2`;
const ZENDESK_AUTH = Buffer.from(`${ZENDESK_CONFIG.email}/token:${ZENDESK_CONFIG.token}`).toString('base64');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function backfillMetrics() {
  try {
    console.log('🚀 Starting metrics backfill...\n');
    
    // Step 1: Get all ticket IDs from database that don't have metrics
    console.log('📊 Fetching ticket IDs from database...');
    const result = await pool.query(`
      SELECT id 
      FROM tickets 
      WHERE metric_set IS NULL
      ORDER BY created_at DESC
    `);
    
    const ticketIds = result.rows.map(row => row.id);
    console.log(`✅ Found ${ticketIds.length} tickets without metrics\n`);
    
    if (ticketIds.length === 0) {
      console.log('🎉 All tickets already have metrics!');
      process.exit(0);
    }
    
    // Step 2: Fetch in batches of 100
    const batchSize = 100;
    const totalBatches = Math.ceil(ticketIds.length / batchSize);
    let processedCount = 0;
    let successCount = 0;
    let errorCount = 0;
    
    console.log(`📦 Processing ${totalBatches} batches of ${batchSize} tickets...\n`);
    
    for (let i = 0; i < ticketIds.length; i += batchSize) {
      const batchNum = Math.floor(i / batchSize) + 1;
      const batch = ticketIds.slice(i, i + batchSize);
      
      try {
        console.log(`\n📄 Batch ${batchNum}/${totalBatches} - Fetching ${batch.length} tickets...`);
        
        // Fetch tickets with metrics from Zendesk
        const url = `${ZENDESK_API_BASE}/tickets/show_many.json?ids=${batch.join(',')}&include=metric_sets`;
        
        const response = await axios.get(url, {
          headers: {
            'Authorization': `Basic ${ZENDESK_AUTH}`,
            'Content-Type': 'application/json'
          }
        });
        
        // Extract metrics
        const metricSetsMap = new Map();
        if (response.data.metric_sets) {
          response.data.metric_sets.forEach(ms => {
            metricSetsMap.set(ms.ticket_id, ms);
          });
        }
        
        console.log(`📊 Extracted ${metricSetsMap.size} metric_sets`);
        
        // Update database
        let batchSuccess = 0;
        for (const ticket of response.data.tickets) {
          const metricSet = metricSetsMap.get(ticket.id);
          
          if (metricSet) {
            try {
              await pool.query(`
                UPDATE tickets SET
                  metric_set = $1::jsonb,
                  reply_count = $2,
                  comment_count = $3,
                  reopens = $4,
                  first_resolution_time_minutes = $5,
                  full_resolution_time_minutes = $6,
                  agent_wait_time_minutes = $7,
                  requester_wait_time_minutes = $8,
                  on_hold_time_minutes = $9
                WHERE id = $10
              `, [
                JSON.stringify(metricSet),
                metricSet.replies ?? null,
                metricSet.full_resolution_time_in_minutes?.business ?? null,
                metricSet.reopens ?? 0,
                metricSet.reply_time_in_minutes?.business ?? null,
                metricSet.full_resolution_time_in_minutes?.business ?? null,
                metricSet.agent_wait_time_in_minutes?.business ?? null,
                metricSet.requester_wait_time_in_minutes?.business ?? null,
                metricSet.on_hold_time_in_minutes?.business ?? null,
                ticket.id
              ]);
              batchSuccess++;
              successCount++;
            } catch (err) {
              console.error(`❌ Error updating ticket ${ticket.id}:`, err.message);
              errorCount++;
            }
          }
        }
        
        processedCount += batch.length;
        const percentComplete = ((processedCount / ticketIds.length) * 100).toFixed(1);
        
        console.log(`✅ Updated ${batchSuccess} tickets in batch ${batchNum}`);
        console.log(`📊 Progress: ${processedCount}/${ticketIds.length} (${percentComplete}%)`);
        console.log(`✅ Success: ${successCount} | ❌ Errors: ${errorCount}`);
        
        // Rate limiting - wait 7 seconds between batches
        if (i + batchSize < ticketIds.length) {
          console.log(`⏳ Waiting 7 seconds (rate limit)...`);
          await sleep(7000);
        }
        
      } catch (error) {
        console.error(`❌ Batch ${batchNum} failed:`, error.message);
        if (error.response?.status === 429) {
          console.log(`⚠️ Rate limited! Waiting 60 seconds...`);
          await sleep(60000);
          i -= batchSize; // Retry this batch
        } else {
          errorCount += batch.length;
        }
      }
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('🎉 BACKFILL COMPLETE!');
    console.log('='.repeat(60));
    console.log(`✅ Successfully updated: ${successCount} tickets`);
    console.log(`❌ Errors: ${errorCount} tickets`);
    console.log(`📊 Total processed: ${processedCount} tickets`);
    console.log('='.repeat(60) + '\n');
    
    process.exit(0);
    
  } catch (error) {
    console.error('\n❌ FATAL ERROR:', error);
    process.exit(1);
  }
}

// Run the backfill
backfillMetrics();