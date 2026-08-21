# Ticket IQ — handover

State as of 20 August 2026. Written to open a new conversation without
relitigating decisions that are already settled.

## Repositories

| | |
|---|---|
| Backend | `~/intlx-assetmgr-backend` — Node/Express on Render, `https://intlxassetmgr-proxy.onrender.com` |
| Frontend | `~/intlx-ticketiq` — Vite + React + TypeScript ZAF app |
| Database | Render Postgres `zdanalytics_v2` |
| Old app | `~/intlx-ticketaudit` — still installed in Zendesk alongside the new one |

Start the backend with `NODE_ENV=production npx nodemon index.js`. The env var
matters: `db.js` only enables SSL when it is set, and Render's Postgres refuses
connections without it. Nodemon was added after a stale process caused the same
confusion five or six times in one session.

**The dev server proxies to Render**, not to localhost. A backend change is
invisible at `localhost:5173` until it is pushed. This cost an hour before it
was noticed.

## Tabs

Ops · Now · Tickets · **Performance** · SLA · Organizations · Time

Performance is the merged Agents and Groups tab. Grouping is a control in the
filter bar rather than two tabs, because the Groups tab showed the same columns
a level up and then drilled into agents to show them a third time.

## The scorecard

`GET /api/analytics/agents/scorecard`, nineteen columns in six bands:

| Band | Columns |
|---|---|
| Assigned | Total, Human, Alarm |
| Solved | Total, Human, Alarm, Human %, Avg handle, Worked |
| Backlog | Opening, Closing (with movement), >7d, >30d |
| Efficiency | 1 touch, 2 touch, 3+ touch |
| Responsiveness | 1st reply, Resolution, Req wait |
| Service quality | Reply met, Res met, Updates |

Plus a team median row, and rows expanding to a summary and ticket list. In
group mode an Agents column shows active over roster.

### Decisions worth not relitigating

**One population per row.** Every rate covers human tickets plus alarms someone
actually handled. Three different scopes in one row — compliance human-only,
touch bands on handled tickets, counts on everything — put Richard Maguire at
48.9% reply compliance in a week where all eight of his customer tickets met
target.

**Self-cleared and merged alarms are excluded throughout**, via the
`alarm_cleared`, `merged_duplicate` and `closed_by_merge` tags. Nobody touched
them, so their response times belong to the platform.

**Requester wait is the exception** — human only, because an alarm has no
requester waiting and including them held the median at zero for every
high-volume agent.

**Each count states its own date basis**: assigned by creation, solved by
resolution, backlog by position. A single toggle cannot serve all three, which
is what made a ticket created at 23:52 and solved next morning appear as solved
on the wrong day.

**Rates carry their base.** 100% of one ticket and 100% of 129 read identically
and are completely different evidence.

**Column definitions build the header and the cell together.** Maintaining them
as parallel lists produced three misalignment bugs in a day, and the symptom —
plausible numbers under the wrong heading — is easy to miss. `buildGroups()` is
a function rather than a constant because the aging labels come from
`ops_settings` and a module-level const captured the defaults at load time.

## Settings

`ops_settings` holds parameters that shape a definition rather than a target:

- `aging_days` = 7
- `aging_days_extended` = 30

Kept out of `ops_goals`, which the Ops dashboard reads wholesale and renders as
goals — an aging threshold there would appear as a 7% target with a goal dot.
The column headers are generated from the values, so changing one is an UPDATE.

## Outstanding

**Code**

- **Per-tab filter scoping in `Controls`.** Eleven filters render on every tab;
  on Performance only Group by, Range, From, To, Source, Organization and
  Priority do anything. A `show` prop was written twice and lost to a revert
  both times. Filters that silently do nothing were explicitly not wanted.
- **Group filter** — `Controls` has no group field at all, so group filtering
  is unavailable despite the endpoint supporting it.
- **Single-agent view.** Benched deliberately: a per-agent table filtered to one
  agent is one row, so this wants its own view with their tickets, their trend,
  and their figures against the team.
- **Analysis summary in the drill-down.** Discussed, not started. Templated
  from thresholds rather than generated.
- Two `::date` casts remain in `/sla/by-priority` — 6× available, currently
  running at 0.42s so not urgent.
- `/groups/performance` starts from tickets, so a group with no activity
  vanishes entirely.
- A staleness health check: if the newest ticket is hours old, something is
  wrong regardless of what the sync reports about itself.

**Watching**

- **Swifteq's "copy all custom field values" setting was unchecked.** It was
  writing 900 and 1800 seconds to the time-tracking fields on merge — 238
  entries, 119 fabricated hours, all on alarm tickets so none reached an
  invoice. Confirm no new entries appear:
  ```sql
  SELECT te.created_at::date, count(*)
  FROM ticket_time_entries te JOIN tickets t ON t.id = te.ticket_id
  WHERE te.time_seconds = 1800
    AND te.created_at < t.created_at + interval '1 minute'
    AND te.created_at > '2026-08-19'
  GROUP BY 1 ORDER BY 1;
  ```
  Zero rows means it stopped. The app-side guard excludes them regardless.

**Conversations rather than code**

- **Time logging is a policy question.** Human tickets are logged at 94–100%
  across the team; alarm tickets split bimodally — Greg 93%, Adrien 95%, against
  Tyler 28%, Christopher 19%, Timothy 7%. Half the team thinks alarm handling
  should be logged and half does not, and both are consistent with their own
  view. Worth settling before ticket time becomes the timesheet.
- **Capacity data.** Real utilization needs contracted hours and the expected
  ticket-work fraction. Project engineers sit in Engineering for access rather
  than for ticket work — 18 members, 11 active — so dividing by the roster
  would be wrong.
- On-hold statuses going unused: 2,577 tickets ran past target with no on-hold
  time recorded.
- Virsae handles 50.5% of its alarms without a human against Alarmtraq's 74.8%.
- Retiring the old ZAF app.

## Hard-won specifics

- Zendesk attributes trigger activity to whoever authored the trigger, so
  `reply_count` and comment authorship cannot tell whether a human did anything
  on an alarm ticket. One account showed 12,118 comments in 90 days.
- `tags` is JSONB: `tags @> '["alarm_cleared"]'::jsonb`.
- `::date` on an indexed timestamp defeats the index — it scans rather than
  seeks. Removing 23 of them took the ops dashboard from 12.8s to 3.2s.
- `endDate` needs an exclusive upper bound at the following midnight, or the
  last day of every range is silently excluded.
- Timestamps are `timestamp without time zone` holding UTC; `db.js` sets an
  explicit type parser, without which every date renders four hours late.
- The ticket sync fails loudly now: if a page fetches tickets and saves none,
  it records an error and leaves the cursor alone. Before that guard, a
  placeholder-count mismatch lost twelve days of tickets while reporting
  success.
