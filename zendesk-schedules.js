#!/usr/bin/env node
/**
 * Read-only: what schedules exist, and which SLA policies use them.
 *
 * Run before deleting a schedule. Zendesk recomputes business-hours metrics
 * against whatever schedule is in force, and the sync does not record which
 * schedule applied to a ticket — so once a schedule is gone there is no way to
 * reconstruct which tickets used it or what their figures were.
 *
 * Prints, per schedule, its weekly intervals as readable days and times, then
 * every SLA policy with its targets and whether each is measured in business
 * or calendar hours.
 *
 *   cd ~/intlx-assetmgr-backend && node zendesk-schedules.js
 */
require('dotenv').config();

const SUB = process.env.ZENDESK_SUBDOMAIN;
const EMAIL = process.env.ZENDESK_EMAIL;
const TOKEN = process.env.ZENDESK_API_TOKEN;

if (!SUB || !EMAIL || !TOKEN) {
  console.error('Missing ZENDESK_SUBDOMAIN, ZENDESK_EMAIL or ZENDESK_API_TOKEN in .env');
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(`${EMAIL}/token:${TOKEN}`).toString('base64');
const base = `https://${SUB}.zendesk.com/api/v2`;

async function get(path) {
  const res = await fetch(base + path, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${res.statusText}`);
  return res.json();
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Zendesk gives minutes since Sunday 00:00. */
function clock(minsFromSunday) {
  const day = Math.floor(minsFromSunday / 1440) % 7;
  const mins = minsFromSunday % 1440;
  const h = String(Math.floor(mins / 60)).padStart(2, '0');
  const m = String(mins % 60).padStart(2, '0');
  return `${DAYS[day]} ${h}:${m}`;
}

function weeklyHours(intervals) {
  return intervals.reduce((n, i) => n + (i.end_time - i.start_time), 0) / 60;
}

(async () => {
  const { schedules } = await get('/business_hours/schedules.json');

  console.log('SCHEDULES');
  console.log('='.repeat(70));
  for (const s of schedules) {
    const hours = weeklyHours(s.intervals || []);
    console.log(`\n[${s.id}] ${s.name}`);
    console.log(`  time zone: ${s.time_zone}`);
    console.log(`  ${hours} hours/week across ${(s.intervals || []).length} intervals`);
    for (const i of s.intervals || []) {
      console.log(`    ${clock(i.start_time)} -> ${clock(i.end_time)}`);
    }
  }

  const { sla_policies: policies } = await get('/slas/policies.json');

  console.log('\n\nSLA POLICIES (in order — first match wins)');
  console.log('='.repeat(70));
  for (const p of policies) {
    console.log(`\n[${p.id}] ${p.title}  (position ${p.position})`);

    // What decides whether a ticket falls under this policy.
    const all = p.filter?.all || [];
    const any = p.filter?.any || [];
    if (all.length) {
      console.log('  matches ALL of:');
      for (const c of all) console.log(`    ${c.field} ${c.operator} ${c.value}`);
    }
    if (any.length) {
      console.log('  matches ANY of:');
      for (const c of any) console.log(`    ${c.field} ${c.operator} ${c.value}`);
    }
    if (!all.length && !any.length) console.log('  (no conditions — catches everything)');

    for (const [priority, targets] of Object.entries(p.policy_metrics || {})) {
      console.log(`  ${priority}:`);
      for (const t of targets) {
        console.log(`    ${t.metric}: ${t.target} min, ${t.business_hours ? 'BUSINESS hours' : 'calendar'}`);
      }
    }
  }

  // policy_metrics is sometimes returned as a flat array rather than keyed by
  // priority, so say plainly when nothing was found rather than implying none.
  const withTargets = policies.filter(p => Object.keys(p.policy_metrics || {}).length);
  if (!withTargets.length) {
    console.log('\nNo policy_metrics returned — dumping the first policy raw:');
    console.log(JSON.stringify(policies[0], null, 2));
  }
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
