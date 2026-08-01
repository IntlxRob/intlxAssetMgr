'use strict';

/**
 * Server-side billing logic. This is the production port of the browser code
 * that used to live in iframe.html (extractBillableStatus / extractTicketTime).
 *
 * Behaviour is deliberately identical to the legacy implementation, including
 * its quirks, so that bin/compare.js reports zero drift. Anything we want to
 * *change* about billing gets changed after parity is proven, not during.
 *
 * The one intentional difference: the billable field ID is configuration, not
 * a runtime fuzzy search. The old code matched field titles against
 * 'billable' | 'bill' | 'chargeable' | 'invoiceable' and took whichever match
 * Zendesk returned first — so adding a field named "Billing contact" could
 * silently change what gets invoiced. Resolve it once, pin it, log it.
 */

const BILLABLE_FIELD_ID = process.env.BILLABLE_FIELD_ID
  ? parseInt(process.env.BILLABLE_FIELD_ID, 10)
  : null;

// Hardcoded in the legacy extractTicketTime. Overridable but rarely changes.
const TIME_FIELD_ID = process.env.TIME_FIELD_ID
  ? parseInt(process.env.TIME_FIELD_ID, 10)
  : 17213443224599;

// Bump when the rules below change, so billing_field_id / billing_computed_at
// can identify which logic produced a stored value.
const BILLING_LOGIC_VERSION = 1;

if (!BILLABLE_FIELD_ID) {
  console.warn(
    '[billing] BILLABLE_FIELD_ID is not set — every ticket will be recorded as ' +
    'not billable. Run bin/discover-fields.js and set it before syncing.'
  );
}

function findField(customFields, id) {
  if (!Array.isArray(customFields)) return undefined;
  return customFields.find(f => f && f.id === id);
}

/**
 * Legacy semantics: boolean true, or the strings 'true' | 'yes' | '1' |
 * 'billable' case-insensitively. Everything else — including absent, null, and
 * any other string — is not billable.
 */
function computeBillable(ticket, fieldId = BILLABLE_FIELD_ID) {
  if (!fieldId) return false;

  const field = findField(ticket.custom_fields, fieldId);
  if (!field) return false;

  const value = field.value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    return lower === 'true' || lower === 'yes' || lower === '1' || lower === 'billable';
  }
  return false;
}

/**
 * Legacy semantics: the stored value is in SECONDS. Numeric strings are parsed
 * with parseFloat after trimming; anything unparseable yields 0. Floored at 0
 * and rounded to whole minutes.
 *
 * Returns ACTUAL minutes. Rounding belongs to billing_policies, not here.
 */
function computeBillableMinutes(ticket, fieldId = TIME_FIELD_ID) {
  const field = findField(ticket.custom_fields, fieldId);
  if (!field) return 0;

  const value = field.value;
  if (value === null || value === undefined || value === '') return 0;

  let minutes = 0;
  if (typeof value === 'number') {
    minutes = value / 60;
  } else if (typeof value === 'string') {
    const parsed = parseFloat(value.trim());
    if (!isNaN(parsed)) minutes = parsed / 60;
  }

  return Math.max(0, Math.round(minutes));
}

/** Everything the sync needs to write, in one call. */
function computeBillingFields(ticket) {
  return {
    is_billable: computeBillable(ticket),
    billable_time_minutes: computeBillableMinutes(ticket),
    billing_field_id: BILLABLE_FIELD_ID,
    billing_computed_at: new Date()
  };
}

/**
 * Populate assignee_name / organization_name from the tables that already hold
 * them. Set-based and cheap; call once after a sync batch rather than per row.
 * The ticket payload does not carry these names, which is why analytics.js
 * reading them returned nulls.
 */
async function refreshDenormalisedNames(pool) {
  const org = await pool.query(`
    UPDATE tickets t
       SET organization_name = o.name
      FROM organizations o
     WHERE t.organization_id = o.id
       AND (t.organization_name IS DISTINCT FROM o.name)
  `);

  let agent = { rowCount: 0 };
  try {
    agent = await pool.query(`
      UPDATE tickets t
         SET assignee_name = a.name
        FROM agents a
       WHERE t.assignee_id = a.id
         AND (t.assignee_name IS DISTINCT FROM a.name)
    `);
  } catch (err) {
    // The agents table may be named differently or not exist yet; this should
    // degrade rather than fail the whole sync.
    console.warn('[billing] assignee_name refresh skipped:', err.message);
  }

  console.log(`[billing] names refreshed — orgs: ${org.rowCount}, agents: ${agent.rowCount}`);
  return { organizations: org.rowCount, agents: agent.rowCount };
}

module.exports = {
  BILLABLE_FIELD_ID,
  TIME_FIELD_ID,
  BILLING_LOGIC_VERSION,
  computeBillable,
  computeBillableMinutes,
  computeBillingFields,
  refreshDenormalisedNames
};
