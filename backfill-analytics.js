// backfill-analytics.js — one-time backfill from a start date to today
const {
  aggregateDailyAnalytics,
  aggregateWeeklyAgentPerformance,
  aggregateMonthlyOrgPerformance
} = require('./services/syncJobs');

const START = new Date('2026-02-25');
const TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function backfillDaily() {
  console.log('\n=== DAILY ===');
  for (let d = new Date(START); d <= TODAY; d.setDate(d.getDate() + 1)) {
    const r = await aggregateDailyAnalytics(new Date(d));
    console.log(`${d.toISOString().split('T')[0]}: ${r.success ? r.records + ' rec' : 'FAIL ' + r.error}`);
    await sleep(250);
  }
}

async function backfillWeekly() {
  console.log('\n=== WEEKLY ===');
  // advance to the first Monday on/after START
  const m = new Date(START);
  const dow = m.getDay();
  m.setDate(m.getDate() + ((dow === 0 ? 1 : 8 - dow) % 7));
  for (let w = new Date(m); w <= TODAY; w.setDate(w.getDate() + 7)) {
    const r = await aggregateWeeklyAgentPerformance(new Date(w));
    console.log(`week ${w.toISOString().split('T')[0]}: ${r && r.success ? 'ok' : 'see log'}`);
    await sleep(250);
  }
}

async function backfillMonthly() {
  console.log('\n=== MONTHLY ===');
  let mo = new Date(START.getFullYear(), START.getMonth(), 1);
  while (mo <= TODAY) {
    const r = await aggregateMonthlyOrgPerformance(new Date(mo));
    console.log(`month ${mo.toISOString().split('T')[0].substring(0,7)}: ${r && r.success ? 'ok' : 'see log'}`);
    mo = new Date(mo.getFullYear(), mo.getMonth() + 1, 1);
    await sleep(250);
  }
}

(async () => {
  try {
    await backfillDaily();
    await backfillWeekly();
    await backfillMonthly();
    console.log('\nBackfill complete.');
  } catch (e) {
    console.error('Backfill error:', e);
  } finally {
    process.exit(0);
  }
})();