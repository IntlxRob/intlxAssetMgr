'use strict';

/**
 * Syncs Zendesk custom statuses into the custom_statuses table.
 *
 * There are roughly 20 of them and they change rarely, so this is a full
 * replace rather than an incremental sync — one API call, one upsert pass.
 *
 * Unlike the /api/custom-statuses endpoint, this does NOT filter out
 * solved/closed. That endpoint excludes them because an agent should not
 * manually set those, but historical tickets reference them and reporting
 * needs the labels.
 */

const axios = require('axios');

const SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN || 'intlxsolutions';

function authHeader() {
  const token = Buffer
    .from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`)
    .toString('base64');
  return { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' };
}

async function syncCustomStatuses(pool) {
  console.log('🏷️  Starting custom status sync...');

  const { data } = await axios.get(
    `https://${SUBDOMAIN}.zendesk.com/api/v2/custom_statuses.json`,
    { headers: authHeader() }
  );

  const statuses = data.custom_statuses || [];
  if (statuses.length === 0) {
    console.warn('⚠️  Zendesk returned no custom statuses — leaving table untouched.');
    return { synced: 0 };
  }

  let synced = 0;
  for (const s of statuses) {
    try {
      await pool.query(`
        INSERT INTO custom_statuses (
          id, agent_label, end_user_label, status_category, active, is_default, synced_at
        ) VALUES ($1, $2, $3, $4, $5, $6, now())
        ON CONFLICT (id) DO UPDATE SET
          agent_label = EXCLUDED.agent_label,
          end_user_label = EXCLUDED.end_user_label,
          status_category = EXCLUDED.status_category,
          active = EXCLUDED.active,
          is_default = EXCLUDED.is_default,
          synced_at = now()
      `, [
        s.id,
        s.agent_label || s.raw_agent_label || s.status_category,
        s.end_user_label || s.raw_end_user_label || null,
        s.status_category,
        s.active !== false,
        s.default === true
      ]);
      synced++;
    } catch (err) {
      console.error(`Error upserting custom status ${s.id}:`, err.message);
    }
  }

  console.log(`✅ Custom status sync completed: ${synced} synced`);
  return { synced };
}

module.exports = { syncCustomStatuses };
