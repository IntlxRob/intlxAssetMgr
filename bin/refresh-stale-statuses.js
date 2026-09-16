/**
 * One-off: refresh tickets whose status is stale.
 *
 * The incremental sync stamped its cursor with NOW() rather than Zendesk's
 * end_time, so every ticket updated while a run was still writing rows was
 * skipped and never revisited. Fifteen months of that left 378 tickets reading
 * open that Zendesk had solved or closed.
 *
 * Fetches by id rather than rewinding the cursor: four calls to show_many
 * against re-walking every ticket since June 2025, and it touches only the
 * rows that are actually wrong.
 *
 *   NODE_ENV=production node bin/refresh-stale-statuses.js
 *   NODE_ENV=production node bin/refresh-stale-statuses.js --dry-run
 */
require('dotenv').config();
const { getPool } = require('../db');

const DRY = process.argv.includes('--dry-run');
const SUB = process.env.ZENDESK_SUBDOMAIN;
const AUTH = 'Basic ' + Buffer.from(
  process.env.ZENDESK_EMAIL + '/token:' + process.env.ZENDESK_API_TOKEN
).toString('base64');

const chunk = (arr, n) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

(async () => {
  const pool = getPool();

  const { rows } = await pool.query(`
    SELECT id FROM tickets
     WHERE status NOT IN ('solved','closed','deleted')
     ORDER BY id
  `);
  const ids = rows.map(r => r.id);
  console.log(`${ids.length} tickets currently unresolved locally`);

  let checked = 0, changed = 0, missing = 0;

  for (const batch of chunk(ids, 100)) {
    const url = `https://${SUB}.zendesk.com/api/v2/tickets/show_many.json`
              + `?ids=${batch.join(',')}`;
    const res = await fetch(url, { headers: { Authorization: AUTH } });
    if (!res.ok) {
      console.error(`  batch failed: ${res.status} ${res.statusText}`);
      continue;
    }
    const data = await res.json();
    const returned = new Map((data.tickets || []).map(t => [String(t.id), t]));

    for (const id of batch) {
      checked++;
      const t = returned.get(String(id));
      if (!t) { missing++; continue; }          // deleted in Zendesk
      if (!['solved', 'closed'].includes(t.status)) continue;

      changed++;
      if (DRY) {
        console.log(`  ${id}: open -> ${t.status}`);
        continue;
      }

      // solved_at lives in the metric set, which show_many does not return, so
      // it is left for the next sync to fill rather than guessed at from
      // updated_at. Status is what the reports are wrong about.
      await pool.query(
        `UPDATE tickets
            SET status = $2,
                custom_status_id = $3,
                updated_at = $4
          WHERE id = $1`,
        [id, t.status, t.custom_status_id, t.updated_at]
      );
    }

    // show_many is not rate-limited the way the incremental endpoints are.
    await new Promise(r => setTimeout(r, 250));
  }

  console.log(`\nchecked ${checked} · ${DRY ? 'would correct' : 'corrected'} ${changed} · ${missing} absent from Zendesk`);

  if (!DRY && changed > 0) {
    const { rows: left } = await pool.query(`
      SELECT count(*)::int AS n FROM tickets
       WHERE status NOT IN ('solved','closed','deleted')
    `);
    console.log(`${left[0].n} genuinely unresolved remain`);
    console.log('\nsolved_at is still null on the corrected rows — the next');
    console.log('ticket sync will fill it from the metric set.');
  }

  await pool.end();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
