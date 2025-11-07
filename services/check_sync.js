require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function checkSyncStatus() {
  const result = await pool.query('SELECT * FROM sync_status WHERE entity_type = $1', ['tickets']);
  console.log('Sync Status:', JSON.stringify(result.rows[0], null, 2));
  await pool.end();
}

checkSyncStatus().catch(console.error);
