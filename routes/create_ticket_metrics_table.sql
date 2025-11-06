-- Create ticket_metrics table
CREATE TABLE IF NOT EXISTS ticket_metrics (
  ticket_id BIGINT PRIMARY KEY,
  
  -- Time metrics (in minutes)
  reply_time_business INTEGER,
  reply_time_calendar INTEGER,
  full_resolution_time_business INTEGER,
  full_resolution_time_calendar INTEGER,
  requester_wait_time_business INTEGER,
  requester_wait_time_calendar INTEGER,
  agent_wait_time_business INTEGER,
  agent_wait_time_calendar INTEGER,
  on_hold_time_business INTEGER,
  on_hold_time_calendar INTEGER,
  
  -- Counts
  reopens INTEGER DEFAULT 0,
  replies INTEGER DEFAULT 0,
  assignee_stations INTEGER DEFAULT 0,
  group_stations INTEGER DEFAULT 0,
  
  -- Satisfaction
  satisfaction_score VARCHAR(20),
  satisfaction_comment TEXT,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_ticket_metrics_ticket_id ON ticket_metrics(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_metrics_updated_at ON ticket_metrics(updated_at);
CREATE INDEX IF NOT EXISTS idx_ticket_metrics_reply_time ON ticket_metrics(reply_time_business);
CREATE INDEX IF NOT EXISTS idx_ticket_metrics_resolution_time ON ticket_metrics(full_resolution_time_business);

-- Add comment
COMMENT ON TABLE ticket_metrics IS 'Stores Zendesk ticket performance metrics for analytics';