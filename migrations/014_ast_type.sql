-- 014: AST Type as a column.
--
-- Which kind of Advanced Services request a ticket is. Already on the form and
-- in custom_fields; this lifts it out so queries do not each extract it their
-- own way.
--
-- Sparsely populated by design at this stage: 120 tickets carry a value across
-- the year. New team, new field. The breakdown showing "(not set)" as its
-- largest row is useful information for whoever owns the process.

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ast_type TEXT;

-- Only Advanced Services uses it today, but no group filter here: if the field
-- starts being used elsewhere the column should reflect that rather than
-- silently ignoring it.
CREATE INDEX IF NOT EXISTS idx_tickets_ast_type
    ON tickets (ast_type) WHERE ast_type IS NOT NULL;
