# syncJobs.js — Stage 1 changes

Three edits. Line numbers refer to the current file.

---

## 1. Import the billing module (near the top, with the other requires)

```js
const {
  computeBillingFields,
  refreshDenormalisedNames,
  BILLABLE_FIELD_ID
} = require('./billing');
```

---

## 2. Replace the INSERT (lines 209–263)

Two things happen here: the four billing columns get added, **and two existing
parameter mappings get corrected.**

### The bugs being fixed

In the current file the values do not line up with the columns:

| Param | Column | Currently receives | Should receive |
|---|---|---|---|
| `$17` | `comment_count` | `full_resolution_time_in_minutes.business` | `metric_set.comments` |
| `$19` | `first_resolution_time_minutes` | `reply_time_in_minutes.business` | `first_resolution_time_in_minutes.business` |

`comment_count` has been storing resolution time in minutes on every synced
ticket. Nothing reads it today, which is why it went unnoticed — but these
tables are about to become the billing source of truth, so it gets fixed now.

If Zendesk's metric set does not expose `comments` on your plan, leave `$17`
as `null` rather than passing something unrelated. A null column is honest;
a wrong one is not.

### Replace with

```js
const billing = computeBillingFields(ticket);

await pool.query(`
  INSERT INTO tickets (
    id, subject, description, status, priority, request_type,
    created_at, updated_at, requester_id, assignee_id,
    organization_id, group_id, tags, custom_fields,
    metric_set, reply_count, comment_count, reopens,
    first_resolution_time_minutes, full_resolution_time_minutes,
    agent_wait_time_minutes, requester_wait_time_minutes, on_hold_time_minutes,
    is_billable, billable_time_minutes, billing_field_id, billing_computed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb,
    $15::jsonb, $16, $17, $18, $19, $20, $21, $22, $23,
    $24, $25, $26, $27)
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
    custom_fields = EXCLUDED.custom_fields,
    metric_set = EXCLUDED.metric_set,
    reply_count = EXCLUDED.reply_count,
    comment_count = EXCLUDED.comment_count,
    reopens = EXCLUDED.reopens,
    first_resolution_time_minutes = EXCLUDED.first_resolution_time_minutes,
    full_resolution_time_minutes = EXCLUDED.full_resolution_time_minutes,
    agent_wait_time_minutes = EXCLUDED.agent_wait_time_minutes,
    requester_wait_time_minutes = EXCLUDED.requester_wait_time_minutes,
    on_hold_time_minutes = EXCLUDED.on_hold_time_minutes,
    is_billable = EXCLUDED.is_billable,
    billable_time_minutes = EXCLUDED.billable_time_minutes,
    billing_field_id = EXCLUDED.billing_field_id,
    billing_computed_at = EXCLUDED.billing_computed_at
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
      JSON.stringify(ticket.custom_fields),
      // Metrics fields
      ticket.metric_set ? JSON.stringify(ticket.metric_set) : null,
      ticket.metric_set?.replies ?? null,
      ticket.metric_set?.comments ?? null,                                    // FIXED: was full_resolution_time
      ticket.metric_set?.reopens ?? 0,
      ticket.metric_set?.first_resolution_time_in_minutes?.business ?? null,  // FIXED: was reply_time
      ticket.metric_set?.full_resolution_time_in_minutes?.business ?? null,
      ticket.metric_set?.agent_wait_time_in_minutes?.business ?? null,
      ticket.metric_set?.requester_wait_time_in_minutes?.business ?? null,
      ticket.metric_set?.on_hold_time_in_minutes?.business ?? null,
      // Billing
      billing.is_billable,
      billing.billable_time_minutes,
      billing.billing_field_id,
      billing.billing_computed_at
    ]);
```

---

## 3. Refresh names after each sync batch

At the end of the ticket sync function, after the page loop finishes and before
`updateSyncStatus('tickets', 'completed')`:

```js
await refreshDenormalisedNames(pool);
```

Set-based, so it costs one statement per sync rather than one per ticket. This
is what makes `organization_name` and `assignee_name` stop being null, which is
what makes nine analytics endpoints start returning real numbers.

---

## Before deploying

`BILLABLE_FIELD_ID` must be set in the environment. Without it every ticket
records as not billable and the module logs a warning on boot. The migration
leaves `is_billable` NULL rather than FALSE precisely so this failure mode is
visible — `SELECT count(*) FROM tickets WHERE is_billable IS NULL` tells you
whether the backfill actually ran.

## Verifying

```bash
psql "$DATABASE_URL" -f migrations/001_billing_columns.sql
BILLABLE_FIELD_ID=<id> node bin/backfill-billing.js
DATABASE_URL=... node bin/compare.js baseline.json --from-db
```

A clean parity report means the port reproduces historical billing exactly.
Any drift gets explained before anything ships — it is either a legacy bug we
are deliberately fixing, or a regression we just introduced, and the diff tells
us which tickets to look at.
