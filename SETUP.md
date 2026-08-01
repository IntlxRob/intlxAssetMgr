# Setup

## 1. Put the files in the repo

Everything drops into `intlx-assetmgr-backend/` alongside what's already there.
The paths matter — `services/billing.js` has to sit next to `syncJobs.js` so the
`require('./billing')` in the patch resolves, and `bin/` has to be at the repo
root so `require('../services/billing')` resolves.

```
intlx-assetmgr-backend/
├── bin/                          <- NEW
│   ├── preflight.js
│   ├── discover-fields.js
│   ├── baseline.js
│   ├── backfill-billing.js
│   ├── compare.js
│   └── model-rounding.js
├── lib/
│   └── legacy-billing.js         <- NEW (reference only, never imported by the app)
├── migrations/
│   └── 001_billing_columns.sql   <- NEW
├── services/
│   ├── billing.js                <- NEW (imported by syncJobs.js)
│   ├── syncJobs.js               <- patched per SYNCJOBS-CHANGES.md
│   └── ...
└── routes/
```

`pg` is already a dependency, so there's nothing to install. If you're running
the harness outside the repo, `npm install pg` covers it.

## 2. Get the database URL

Render dashboard → your Postgres instance → **Connections**.

Two URLs are shown and the difference matters:

- **Internal Database URL** — only resolves from inside Render. Use this if
  you're running from a Render shell.
- **External Database URL** — use this from a laptop. Requires SSL, which the
  scripts already handle (`rejectUnauthorized: false`, since Render doesn't
  present a chain Node trusts by default).

```bash
export DATABASE_URL='postgresql://user:pass@dpg-xxxxx.oregon-postgres.render.com/dbname'
```

If Render has IP allowlisting enabled on the instance, add your address first
or the connection will hang rather than fail cleanly.

For a local Postgres instead, add `PGSSL=disable`.

## 3. Preflight

```bash
node bin/preflight.js
```

Writes nothing. Checks node version, driver, connectivity, required tables,
whether `custom_fields` is actually populated, whether the migration has already
run, and whether your database user can create objects. It ends by telling you
which command comes next, so you can't lose your place.

Fix anything marked `[XX]` before continuing. `[--]` is informational.

## 4. Resolve the billable field

```bash
node bin/discover-fields.js --limit 50000
```

This is the one input nobody can supply from outside your data. The legacy app
matched field *titles* at runtime against `billable | bill | chargeable |
invoiceable` and took whichever Zendesk returned first — so there has never been
a fixed ID to copy.

Expect one strong candidate: a field populated on a large share of tickets with
two or three distinct boolean-ish values.

**If two candidates look plausible, stop.** Work out which one has actually been
driving invoices before pinning anything. Getting this wrong silently rebills
your entire history.

```bash
export BILLABLE_FIELD_ID=<the id>
```

## 5. Freeze the baseline — before the migration

```bash
node bin/baseline.js --from 2024-01-01 --to 2025-07-01 --out baseline.json
```

Commit `baseline.json`. This is the reference every later change gets diffed
against, and it has to be captured while the database is still untouched.

While you're here, the rounding question answers itself:

```bash
node bin/model-rounding.js baseline.json --rate 200
```

## 6. Migrate

```bash
psql "$DATABASE_URL" -f migrations/001_billing_columns.sql
```

Additive, transactional, and safe to run twice. Adds columns, indexes, the
`billing_policies` table seeded with your current behaviour, and the
`tickets_billed` view.

No application code reads the new columns yet, so this is deployable on its own.

## 7. Backfill

```bash
node bin/backfill-billing.js --dry-run   # look first
node bin/backfill-billing.js
```

Batched and resumable. Re-running is safe; it only touches rows where
`is_billable IS NULL` unless you pass `--all`.

## 8. Prove parity

```bash
node bin/compare.js baseline.json --from-db
```

Exits 0 on an exact match. Any drift lists the specific tickets, and each one
is either a legacy bug you're deliberately fixing or a regression you just
introduced — the diff tells you which.

**Do not apply the syncJobs patch until this is clean.**

## 9. Patch the sync and deploy

Follow `SYNCJOBS-CHANGES.md`. Set `BILLABLE_FIELD_ID` in the Render environment
before deploying — without it the module logs a warning on boot and records
every ticket as not billable.

After the first sync completes, re-run step 8. It should still be clean.

---

## Rollback

Nothing here is destructive, but if you need to back out:

```sql
BEGIN;
DROP VIEW IF EXISTS tickets_billed;
DROP FUNCTION IF EXISTS billing_policy_for(BIGINT, DATE);
DROP FUNCTION IF EXISTS apply_rounding(INTEGER, INTEGER, INTEGER);
DROP TABLE IF EXISTS billing_policies;
ALTER TABLE tickets
  DROP COLUMN IF EXISTS is_billable,
  DROP COLUMN IF EXISTS billable_time_minutes,
  DROP COLUMN IF EXISTS assignee_name,
  DROP COLUMN IF EXISTS organization_name,
  DROP COLUMN IF EXISTS billing_computed_at,
  DROP COLUMN IF EXISTS billing_field_id;
COMMIT;
```

Reverting `syncJobs.js` is a git revert. Existing ticket rows are never
modified by any of this apart from the new columns, so there's no data to
restore.

## Troubleshooting

**`self signed certificate in certificate chain`** — you're on a local Postgres.
Add `PGSSL=disable`.

**Connection hangs, no error** — Render IP allowlist, or you're using the
Internal URL from outside Render. Preflight flags the second case.

**`discover-fields.js` finds no candidates** — the heuristic looks for fields
with ≤4 distinct, mostly boolean-ish values. If your billable field uses a
tagger with many options, read the "ALL FIELDS BY POPULATION" table at the
bottom of its output and pick manually.

**Backfill reports many billable tickets with zero tracked time** — not a bug in
the tooling. Those tickets bill nothing under `ceil()`. Worth understanding
before go-live; it's either a time-tracking gap or uncollected revenue.
