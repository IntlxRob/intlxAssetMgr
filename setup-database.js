// setup-database.js
// Run this once to create the analytics database schema

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false  // Required for Render PostgreSQL
    }
});

async function setupDatabase() {
    const client = await pool.connect();
    
    try {
        console.log('🔧 Creating analytics schema...');
        
        // Create schema
        await client.query(`CREATE SCHEMA IF NOT EXISTS analytics;`);
        console.log('✅ Schema created');
        
        // Create tickets table
        console.log('🔧 Creating tickets table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS analytics.tickets (
                id BIGINT PRIMARY KEY,
                organization_id BIGINT,
                organization_name VARCHAR(255),
                subject TEXT,
                description TEXT,
                status VARCHAR(50),
                priority VARCHAR(50),
                severity VARCHAR(50),
                request_type VARCHAR(100),
                assignee_id BIGINT,
                assignee_name VARCHAR(255),
                requester_id BIGINT,
                requester_name VARCHAR(255),
                group_id BIGINT,
                group_name VARCHAR(100),
                created_at TIMESTAMP NOT NULL,
                updated_at TIMESTAMP,
                solved_at TIMESTAMP,
                closed_at TIMESTAMP,
                due_at TIMESTAMP,
                tags TEXT[],
                custom_fields JSONB,
                is_billable BOOLEAN DEFAULT false,
                billable_time_minutes INTEGER,
                synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Tickets table created');
        
        // Create indexes
        console.log('🔧 Creating indexes...');
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_tickets_org ON analytics.tickets(organization_id);
            CREATE INDEX IF NOT EXISTS idx_tickets_created ON analytics.tickets(created_at);
            CREATE INDEX IF NOT EXISTS idx_tickets_solved ON analytics.tickets(solved_at);
            CREATE INDEX IF NOT EXISTS idx_tickets_status ON analytics.tickets(status);
            CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON analytics.tickets(assignee_id);
            CREATE INDEX IF NOT EXISTS idx_tickets_group ON analytics.tickets(group_id);
            CREATE INDEX IF NOT EXISTS idx_tickets_billable ON analytics.tickets(is_billable);
        `);
        console.log('✅ Indexes created');
        
        // Create metrics table
        console.log('🔧 Creating metrics table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS analytics.metrics (
                ticket_id BIGINT PRIMARY KEY REFERENCES analytics.tickets(id) ON DELETE CASCADE,
                first_reply_time_minutes INTEGER,
                full_resolution_time_minutes INTEGER,
                agent_wait_time_minutes INTEGER,
                requester_wait_time_minutes INTEGER,
                on_hold_time_minutes INTEGER,
                reply_count INTEGER,
                reopens INTEGER,
                is_one_touch BOOLEAN,
                is_two_touch BOOLEAN,
                sla_breach BOOLEAN DEFAULT false,
                sla_policy_name VARCHAR(255),
                computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Metrics table created');
        
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_metrics_ticket ON analytics.metrics(ticket_id);
        `);
        
        // Create sync status table
        console.log('🔧 Creating sync_status table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS analytics.sync_status (
                id SERIAL PRIMARY KEY,
                sync_type VARCHAR(50),
                started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP,
                tickets_synced INTEGER DEFAULT 0,
                tickets_failed INTEGER DEFAULT 0,
                last_ticket_id BIGINT,
                last_ticket_date TIMESTAMP,
                status VARCHAR(50),
                error_message TEXT
            );
        `);
        console.log('✅ Sync status table created');
        
        // Verify tables
        const result = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'analytics'
            ORDER BY table_name;
        `);
        
        console.log('\n✅ Database setup complete!');
        console.log('📋 Tables created:', result.rows.map(r => r.table_name).join(', '));
        
    } catch (error) {
        console.error('❌ Database setup failed:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

// Run the setup
setupDatabase()
    .then(() => {
        console.log('🎉 All done! Your database is ready.');
        process.exit(0);
    })
    .catch(error => {
        console.error('Failed to setup database:', error);
        process.exit(1);
    });
