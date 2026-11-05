-- 018_billing_audit.sql
--
-- The monthly T&M billing audit's decision, per ticket.
--
-- Background: claude/billing-audit.md
--
-- ---------------------------------------------------------------------------
-- Why this is not a Zendesk custom field
-- ---------------------------------------------------------------------------
--
-- It was, for about an hour on 2026-11-05. Closed tickets reject custom field
-- writes:
--
--   HTTP 422 {"status":[{"description":"One of the updates to a closed
--             ticket was rejected"}]}
--
-- Zendesk's default automation closes a ticket four days after it is solved.
-- #137579 was solved 2026-10-29 and closed 2026-11-02. The audit runs after
-- month end, so every ticket it is about is closed by then: the audit
-- population and the unwritable set are the same set.
--
-- The same 422 applies to is_billable, which is why the audit does not touch
-- it. "Not billable" is chargeable_minutes = 0 here. is_billable keeps its own
-- meaning - what the agent marked - and this records separately what
-- accounting decided. The spreadsheet already keeps them in two columns.
--
-- ---------------------------------------------------------------------------
-- Row presence is the reviewed flag
-- ---------------------------------------------------------------------------
--
--   a row       audited; charge chargeable_minutes
--   no row      not audited
--
-- So 0 is an ordinary value rather than a convention, and the empty-versus-zero
-- ambiguity that shaped two earlier designs does not arise. In the spreadsheet
-- a blank Audit cell means both "charge in full" and "nobody has looked" - the
-- thing that makes duplicate work invisible.
--
-- NOT NULL on chargeable_minutes is load bearing for that: a row with a null
-- value would reintroduce exactly the ambiguity this shape removes.

BEGIN;

CREATE TABLE IF NOT EXISTS ticket_billing_audit (
    -- No FK to tickets. That table is rebuilt by the sync, and an audit
    -- decision outliving a resync is correct: the decision is accounting's,
    -- not Zendesk's.
    ticket_id          bigint      PRIMARY KEY,

    -- Minutes to actually charge. 0 means audited and not chargeable.
    -- Never null: absence of a row is how "not audited" is expressed.
    chargeable_minutes integer     NOT NULL CHECK (chargeable_minutes >= 0),

    -- Answers "has October been done yet", which is the question asked at the
    -- start of every run.
    audited_at         timestamptz NOT NULL DEFAULT now(),

    -- Nullable, and nobody asked for it. It is here because it is the one
    -- thing that cannot be added retroactively - the history simply would not
    -- exist. Costs a column; buys the answer if the question is ever asked.
    audited_by         text
);

COMMENT ON TABLE ticket_billing_audit IS
    'Monthly T&M billing audit. A row means the ticket was audited; '
    'chargeable_minutes is what to invoice, 0 meaning nothing. Not a Zendesk '
    'field because closed tickets reject writes and the audit runs on closed '
    'tickets. See claude/billing-audit.md.';

COMMENT ON COLUMN ticket_billing_audit.chargeable_minutes IS
    'Minutes to invoice. Compare with tickets_billed.billed_minutes: the '
    'difference is the write-off the spreadsheet called Audit.';

-- The report asks "what was audited in this period", which arrives as a set of
-- ticket ids from the ticket query rather than as a date range on this table -
-- so the primary key carries the join. This index serves the other question,
-- "when was this month last worked on".
CREATE INDEX IF NOT EXISTS ticket_billing_audit_audited_at_idx
    ON ticket_billing_audit (audited_at DESC);

COMMIT;
