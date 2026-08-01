'use strict';

/**
 * Billing logic extracted VERBATIM from iframe.html.
 *
 * DO NOT "improve" anything in this file. Its only job is to reproduce the
 * behaviour that has historically produced invoices, so that any future
 * server-side implementation can be diffed against it.
 *
 * The only permitted changes from the original are mechanical de-DOM-ing:
 *   - `billableFieldId` was a module-global set by runtime field discovery;
 *     it is now an explicit argument.
 *   - `getRoundedTime` read its interval from a <select>; it is now an
 *     explicit argument.
 * Behaviour is otherwise byte-for-byte the same, including the quirks.
 */

// Time field ID is hardcoded in the original (extractTicketTime).
const TIME_FIELD_ID = 17213443224599;

/**
 * iframe.html:5022 (note: a stub with an empty body is declared at :5018 and
 * shadowed by hoisting — this is the implementation that actually runs).
 */
function extractBillableStatus(ticket, billableFieldId) {
  let billable = false;

  if (billableFieldId && ticket.custom_fields && ticket.custom_fields.length > 0) {
    const billableField = ticket.custom_fields.find(field =>
      field.id === billableFieldId
    );

    if (billableField) {
      const billableValue = billableField.value;
      if (typeof billableValue === 'boolean') {
        billable = billableValue;
      } else if (typeof billableValue === 'string') {
        const lowerValue = billableValue.toLowerCase();
        billable = lowerValue === 'true' || lowerValue === 'yes' ||
                  lowerValue === '1' || lowerValue === 'billable';
      }
    }
  }

  return billable;
}

/**
 * iframe.html, extractTicketTime.
 * NOTE: the stored value is in SECONDS. Numeric strings are parsed; anything
 * unparseable yields 0. Result is floored at 0 and rounded to whole minutes.
 */
function extractTicketTime(ticket) {
  let minutes = 0;

  if (ticket.custom_fields && ticket.custom_fields.length > 0) {
    const timeField = ticket.custom_fields.find(field =>
      field.id === TIME_FIELD_ID && field.value !== null && field.value !== undefined && field.value !== ''
    );

    if (timeField) {
      const timeValue = timeField.value;

      if (typeof timeValue === 'number') {
        minutes = timeValue / 60;
      } else if (typeof timeValue === 'string') {
        const numValue = parseFloat(timeValue.trim());
        if (!isNaN(numValue)) {
          minutes = numValue / 60;
        }
      }
    }
  }

  return Math.max(0, Math.round(minutes));
}

/**
 * iframe.html, getRoundedTime. Ceil to the next interval, no minimum.
 * A 0-minute ticket bills 0; a 1-minute ticket bills a full interval.
 */
function getRoundedTime(minutes, roundingInterval) {
  const interval = parseInt(roundingInterval, 10) || 30;
  return Math.ceil(minutes / interval) * interval;
}

/**
 * iframe.html, isTicketClosed. Note this returns true for 'solved' as well as
 * 'closed' — "closed" in the UI means "no longer editable via the Zendesk API".
 */
function isTicketClosed(ticket) {
  return ticket.status === 'closed' || ticket.status === 'solved';
}

/**
 * Full per-ticket evaluation under the legacy rules.
 * Session-only overrides are deliberately NOT modelled: they never survive a
 * page refresh, so they cannot have influenced a saved invoice.
 */
function evaluateTicket(ticket, { billableFieldId, roundingInterval }) {
  const billable = extractBillableStatus(ticket, billableFieldId);
  const actualMinutes = extractTicketTime(ticket);
  const roundedMinutes = getRoundedTime(actualMinutes, roundingInterval);

  return {
    id: ticket.id,
    status: ticket.status,
    organization_id: ticket.organization_id,
    billable,
    actual_minutes: actualMinutes,
    rounded_minutes: roundedMinutes,
    billed_minutes: billable ? roundedMinutes : 0,
    is_closed: isTicketClosed(ticket)
  };
}

module.exports = {
  TIME_FIELD_ID,
  extractBillableStatus,
  extractTicketTime,
  getRoundedTime,
  isTicketClosed,
  evaluateTicket
};
