'use strict';

/**
 * Server-side port of the derived-field logic that used to run in the browser
 * (iframe.html: extractRequestType, detectVisualizeTierFromTags,
 * extractFirstReplyTime, extractResolutionTime).
 *
 * Behaviour is identical to lib/legacy-derived.js, quirks included, so
 * bin/derived-compare.js reports zero drift. Improvements come after parity is
 * proven, not during.
 *
 * Scope note: sla_status and visualize_tier are deliberately absent. See
 * migrations/002_derived_fields.sql for why.
 */

const REQUEST_TYPE_FIELD_ID = process.env.REQUEST_TYPE_FIELD_ID
  ? parseInt(process.env.REQUEST_TYPE_FIELD_ID, 10) : 22563831352855;
const FIRST_REPLY_FIELD_ID = process.env.FIRST_REPLY_FIELD_ID
  ? parseInt(process.env.FIRST_REPLY_FIELD_ID, 10) : 35345064770327;
const RESOLUTION_FIELD_ID = process.env.RESOLUTION_FIELD_ID
  ? parseInt(process.env.RESOLUTION_FIELD_ID, 10) : 35345460512663;

const DERIVED_LOGIC_VERSION = 1;

function lowerTags(ticket) {
  if (!ticket.tags || !Array.isArray(ticket.tags)) return [];
  return ticket.tags.map(t => String(t).toLowerCase());
}

function findField(customFields, id) {
  if (!Array.isArray(customFields)) return undefined;
  return customFields.find(f => f && f.id === id);
}

/** Custom field wins; '-' counts as unset. Then tags, virsae first. */
function computeRequestType(ticket) {
  const field = findField(ticket.custom_fields, REQUEST_TYPE_FIELD_ID);
  if (field && field.value && field.value !== '-') return field.value;

  const tags = lowerTags(ticket);
  if (tags.includes('virsae'))    return 'alarm_virsae';
  if (tags.includes('alarmtraq')) return 'alarm_alarmtraq';
  if (tags.includes('checkmk'))   return 'alarm_checkmk';
  return null;
}

function computeAlarmFlags(ticket) {
  const tags = lowerTags(ticket);
  return {
    has_alarmtraq: tags.includes('alarmtraq'),
    has_virsae:    tags.includes('virsae'),
    has_checkmk:   tags.includes('checkmk')
  };
}

/**
 * metric_set first, then the custom-field fallback (seconds).
 *
 * The `||` between business and calendar is intentional and matches the
 * browser: a business time of 0 is falsy and falls through to calendar. This
 * may be inflating first-reply averages for tickets answered immediately
 * during business hours, but changing it would be a behaviour change, so it
 * stays until parity is proven and the change is made deliberately.
 */
function computeFirstReplyMinutes(ticket) {
  if (ticket.metric_set) {
    const minutes = ticket.metric_set.reply_time_in_minutes?.business ||
                    ticket.metric_set.reply_time_in_minutes?.calendar;
    if (minutes) return Math.round(minutes);
  }

  const field = findField(ticket.custom_fields, FIRST_REPLY_FIELD_ID);
  if (!field || field.value === null || field.value === undefined || field.value === '') return null;

  if (typeof field.value === 'number') return Math.round(field.value / 60);
  if (typeof field.value === 'string') {
    const n = parseFloat(field.value.trim());
    if (!isNaN(n)) return Math.round(n / 60);
  }
  return null;
}

function computeResolutionMinutes(ticket) {
  if (ticket.metric_set) {
    const minutes = ticket.metric_set.full_resolution_time_in_minutes?.business ||
                    ticket.metric_set.full_resolution_time_in_minutes?.calendar;
    if (minutes) return Math.round(minutes);
  }

  const field = findField(ticket.custom_fields, RESOLUTION_FIELD_ID);
  if (!field || field.value === null || field.value === undefined || field.value === '') return null;

  if (typeof field.value === 'number') return Math.round(field.value / 60);
  if (typeof field.value === 'string') {
    const n = parseFloat(field.value.trim());
    if (!isNaN(n)) return Math.round(n / 60);
  }
  return null;
}

/** Everything the sync writes, in one call. */
function computeDerivedFields(ticket) {
  return {
    request_type_derived: computeRequestType(ticket),
    first_reply_minutes: computeFirstReplyMinutes(ticket),
    resolution_minutes: computeResolutionMinutes(ticket),
    derived_computed_at: new Date(),
    ...computeAlarmFlags(ticket)
  };
}

module.exports = {
  REQUEST_TYPE_FIELD_ID,
  FIRST_REPLY_FIELD_ID,
  RESOLUTION_FIELD_ID,
  DERIVED_LOGIC_VERSION,
  computeRequestType,
  computeAlarmFlags,
  computeFirstReplyMinutes,
  computeResolutionMinutes,
  computeDerivedFields
};
