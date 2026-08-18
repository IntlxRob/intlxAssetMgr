ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS expects_time_logging BOOLEAN NOT NULL DEFAULT true;

-- Procurement work is orders and licences rather than billable engineering
-- time. Flagging the group rather than the people keeps the rule visible and
-- survives someone moving teams.
UPDATE groups SET expects_time_logging = false
 WHERE name IN ('Procurement', 'Sales', 'Marketing', 'Managers');
