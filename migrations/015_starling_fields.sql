-- 015: Starling location and department.
--
-- Required on the ticket backing report Starling receives; they use both to
-- decide where to charge the cost. Populated on 4,301 of their tickets and
-- effectively nowhere else.
--
-- Stored raw. The values are slugs - 1210_wethersfield_suite_103,
-- allergy_and_immunology - and that is what Starling matches on, so no
-- prettifying here or at display.

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS starling_location TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS starling_department TEXT;

CREATE INDEX IF NOT EXISTS idx_tickets_starling_location
    ON tickets (starling_location) WHERE starling_location IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_starling_department
    ON tickets (starling_department) WHERE starling_department IS NOT NULL;
