#!/usr/bin/env node
//
// bin/check-webhook-health.js
//
// Reports which Zendesk webhooks are failing, and how badly.
//
//   ZENDESK_OAUTH_SCOPES="webhooks:read" node bin/check-webhook-health.js
//   ... --hours 6          # window to judge (default 24)
//   ... --all              # include webhooks with no recent traffic
//   ... --quiet            # only print failures; exit code carries the result
//
// Exit 0 = nothing failing in the window. Exit 1 = at least one webhook is
// returning errors. Suitable for cron.
//
// Why this exists
// ---------------
// On 2026-09-23 the `Update Ticket` webhook began returning 401 on every call,
// because a service account was renamed and the stored credential still named
// the old address. It failed roughly thirteen times an hour for six days and
// nobody noticed, because the only symptom was a custom field quietly not
// being populated. 1,101 tickets are missing their original assignee as a
// result.
//
// Nothing in Zendesk alerts on this. The invocations endpoint knows, but only
// if something asks.
//
// Note on scope: the backend's default OAuth scopes deliberately exclude
// webhook management, so run this with ZENDESK_OAUTH_SCOPES set as above.

'use strict';

require('dotenv').config({ quiet: true });

const axios = require('axios');
const { authHeader, ZENDESK_API_BASE } = require('../services/zendeskAuth');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const HOURS = Number(flag('hours', 24));
const SHOW_ALL = argv.includes('--all');
const QUIET = argv.includes('--quiet');

// Zendesk retries, so an occasional failure among successes is normal. What
// matters is a webhook where nothing is getting through.
const FAIL_RATIO_ALERT = 0.5;

const say = (...a) => { if (!QUIET) console.log(...a); };

async function main() {
  const cutoff = new Date(Date.now() - HOURS * 3600 * 1000);
  const headers = { Authorization: await authHeader() };

  const { data } = await axios.get(`${ZENDESK_API_BASE}/webhooks`, {
    params: { 'page[size]': 100 },
    headers
  });

  const active = (data.webhooks || []).filter((w) => w.status === 'active');
  say(`${active.length} active webhooks | window: last ${HOURS}h (since ${cutoff.toISOString()})\n`);

  const failing = [];
  const healthy = [];
  const idle = [];

  for (const w of active) {
    let rows = [];
    try {
      const res = await axios.get(`${ZENDESK_API_BASE}/webhooks/${w.id}/invocations`, { headers });
      rows = res.data.invocations || [];
    } catch (err) {
      failing.push({
        name: w.name,
        id: w.id,
        note: `could not read invocations (HTTP ${err.response && err.response.status})`
      });
      continue;
    }

    const recent = rows.filter((r) => new Date(r.latest_completed_at) >= cutoff);
    if (recent.length === 0) {
      idle.push({ name: w.name, id: w.id, endpoint: w.endpoint });
      continue;
    }

    const ok = recent.filter((r) => r.status_code >= 200 && r.status_code < 300).length;
    const bad = recent.length - ok;
    const ratio = bad / recent.length;
    const entry = {
      name: w.name,
      id: w.id,
      endpoint: w.endpoint,
      total: recent.length,
      ok,
      bad,
      ratio,
      sample: recent.find((r) => !(r.status_code >= 200 && r.status_code < 300))
    };

    if (bad > 0 && ratio >= FAIL_RATIO_ALERT) failing.push(entry);
    else healthy.push(entry);
  }

  if (failing.length) {
    console.log(`FAILING (${failing.length}):`);
    for (const f of failing) {
      if (f.note) {
        console.log(`  ${f.name}  —  ${f.note}`);
        continue;
      }
      const pct = Math.round(f.ratio * 100);
      console.log(`  ${f.name}`);
      console.log(`    ${f.bad}/${f.total} failed (${pct}%)  ${f.endpoint}`);
      if (f.sample) {
        console.log(`    latest failure: ${f.sample.latest_completed_at}  ${f.sample.status_code}  ${f.sample.status}`);
      }
    }
    console.log('');
  }

  say(`HEALTHY (${healthy.length}):`);
  healthy
    .sort((a, b) => b.bad - a.bad)
    .forEach((h) => say(`  ${h.name}  ${h.ok}/${h.total} ok${h.bad ? `  (${h.bad} transient)` : ''}`));

  if (SHOW_ALL) {
    say(`\nIDLE — no invocations in the window (${idle.length}):`);
    idle.forEach((i) => say(`  ${i.name}`));
  } else {
    say(`\n${idle.length} webhook(s) had no traffic in the window (--all to list).`);
  }

  if (failing.length) {
    console.log(`\n${failing.length} webhook(s) failing. A credential that has gone stale looks exactly like this.`);
    process.exit(1);
  }

  say('\nNo webhooks failing in the window.');
}

main().catch((err) => {
  console.error('FAILED:', err.response ? err.response.status : '', err.message);
  process.exit(2);
});
