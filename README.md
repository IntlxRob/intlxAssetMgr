# Ticket IQ billing parity harness

Stage 0 of the Ticket IQ rebuild. Nothing here changes production. Its job is to
freeze current billing behaviour into a contract that every later change gets
diffed against, so we can move billing logic server-side without silently
changing what customers get invoiced.

## Why this exists

Billing logic currently lives in `iframe.html` and runs in the browser. The plan
moves it into `syncJobs.js` so it computes once at write time. That is the right
architecture, but it is also the single riskiest change in the project: if the
new implementation disagrees with the old one on even a handful of tickets, the
first symptom is a customer disputing an invoice.

So we capture the old behaviour first, exactly as it is — quirks included — and
treat any divergence as something to be explained rather than discovered later.

## Setup

```bash
npm install
export DATABASE_URL='postgres://...'
# If your host does not present a valid cert chain (Render does not):
#   the scripts already pass rejectUnauthorized:false. Use PGSSL=disable for local.
```

## Run order

### 1. Resolve the billable field

```bash
node bin/discover-fields.js --limit 50000
```

The legacy app finds this field at runtime by fuzzy-matching field titles
against `billable | bill | chargeable | invoiceable` and taking whichever match
Zendesk returns first. That is non-deterministic — a field named "Billing
contact" matches — and it must not be carried into the backend.

This script instead profiles every custom field actually present on synced
tickets and reports value distributions, so the ID gets pinned with evidence.

**Expect exactly one strong candidate.** If two fields look boolean-ish and
well-populated, stop and work out which one has been driving invoices before
going further.

### 2. Freeze the baseline

```bash
BILLABLE_FIELD_ID=<id from step 1> node bin/baseline.js \
  --from 2024-01-01 --to 2025-07-01 --interval 30 --out baseline.json
```

Runs the verbatim legacy logic over real tickets and writes a per-ticket record
of billable flag, tracked minutes, and billed minutes. **Commit this file.** It
is the reference point for everything that follows.

### 3. Model the rounding change

```bash
node bin/model-rounding.js baseline.json --rate 200
```

Answers the 30-vs-15 question with your data: total revenue delta, which ticket
sizes absorb it, and per-organization exposure. Contracts are negotiated per
org, so the third table is the one that matters for the decision.

### 4. Gate every subsequent change

```bash
# after the Stage 1 sync port + backfill
DATABASE_URL=... node bin/compare.js baseline.json --from-db
```

Exits non-zero on any drift, so it can sit in CI or a pre-deploy check. Clean
run means the server-side implementation reproduces historical billing exactly.

## What the legacy logic actually does

Documented here because some of it is surprising, and all of it currently
drives real invoices:

| Behaviour | Detail |
|---|---|
| Billable flag | Custom field. `true` (boolean), or string `true`/`yes`/`1`/`billable`, case-insensitive. Anything else, including absent, is not billable. |
| Tracked time | Field `17213443224599`, stored in **seconds**. Numeric strings are parsed; unparseable values yield 0. Floored at 0, rounded to whole minutes. |
| Rounding | `Math.ceil(minutes / interval) * interval`. No minimum. |
| 1-minute ticket | Bills a full interval — 30 minutes under current policy. |
| 0-minute ticket | Bills nothing, even when flagged billable. Worth auditing: these are tickets someone marked billable that produce no revenue. |
| `isTicketClosed` | Returns true for `solved` **and** `closed` — it means "no longer editable via the Zendesk API", not "resolved". |

## Deliberate omissions

**Session-only overrides are not modelled.** `saveBillableOverrides()` is a
no-op and `billableOverrides` resets to `{}` on every page load, so an override
cannot have influenced a saved invoice. Excluding them is what makes the
baseline reproducible.

The open-ticket branch of `toggleBillable` is a different matter — it writes to
Zendesk and does persist. Those writes are already reflected in the synced
`custom_fields`, so the baseline picks them up naturally.

## Known landmine

`extractBillableStatus` is declared twice in `iframe.html` — a stub with an
empty body at line 5018, then the real implementation at 5022. Hoisting means
the second wins, so it works today. It works by luck. Reordering that file
silently breaks billing, and nothing would fail loudly.

The version in `lib/legacy-billing.js` is the real one.

---

# Stage 1 — make the database the billing source of truth

Files: `migrations/001_billing_columns.sql`, `services/billing.js`,
`bin/backfill-billing.js`, `SYNCJOBS-CHANGES.md`.

Verified against a real PostgreSQL 16 instance: the migration applies cleanly,
is idempotent, and `services/billing.js` reproduces `lib/legacy-billing.js`
across all 31 tested edge cases.

## Order of operations

```bash
# 1. resolve and pin the billable field
node bin/discover-fields.js --limit 50000

# 2. freeze current behaviour BEFORE changing anything
BILLABLE_FIELD_ID=<id> node bin/baseline.js --out baseline.json

# 3. apply the migration (safe, additive, re-runnable)
psql "$DATABASE_URL" -f migrations/001_billing_columns.sql

# 4. backfill history — dry run first
BILLABLE_FIELD_ID=<id> node bin/backfill-billing.js --dry-run
BILLABLE_FIELD_ID=<id> node bin/backfill-billing.js

# 5. prove parity
node bin/compare.js baseline.json --from-db

# 6. only then apply SYNCJOBS-CHANGES.md and deploy
```

Step 2 must happen before step 3. Once the migration runs there is no way back
to an unmodified reference point.

## Design notes

**Actual minutes are stored; rounding is applied at query time.** Rounding is a
policy, not a fact about a ticket. `billing_policies` is effective-dated and
scoped per organization, so changing the increment cannot retroactively alter a
period you have already invoiced. Verified: switching the global policy to 15
minutes from 2025-01-01 left 2024 tickets billing at 30.

**`is_billable` is nullable on purpose.** NULL means "not yet computed" and is
distinct from FALSE. `SELECT count(*) FROM tickets WHERE is_billable IS NULL`
tells you whether the backfill actually completed — a partial run is visible
rather than silently reading as "nothing is billable".

**The billable field ID is configuration and is recorded per row.**
`billing_field_id` and `billing_computed_at` mean a change in field resolution
is detectable after the fact rather than invisible.

## Follow-up for Stage 3

`/billing/summary` and `/billing/by-organization` in `routes/analytics.js` sum
`billable_time_minutes` directly, which is *actual* time. They should read
`billed_minutes` from the `tickets_billed` view so that reported hours match
invoiced hours. Left alone here deliberately — Stage 1 changes no endpoint
behaviour.

## Open question the backfill will answer

Tickets flagged billable with zero tracked time bill nothing under `ceil()`.
The backfill counts them. If that number is large, it is either a time-tracking
gap or revenue quietly going uncollected, and it is worth understanding before
the billing logic is set in stone.
