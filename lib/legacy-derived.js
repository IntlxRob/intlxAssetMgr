'use strict';

/**
 * Derived-field logic extracted VERBATIM from assets/iframe.html.
 *
 * Same contract as lib/legacy-billing.js: DO NOT improve anything here. This
 * file exists to reproduce what the browser currently computes, so a
 * server-side port can be diffed against it before it drives anything.
 *
 * Covers the four fields that applyFilters() and updateUI() depend on but
 * which have no column behind them:
 *
 *   requestType    -> the Request Type filter
 *   alarm flags    -> the Alarm filter (alarmtraq / virsae / checkmk)
 *   slaStatus      -> the SLA compliance card
 *   visualizeTier  -> the Support Level filter   (see caveat below)
 *
 * CAVEAT on visualizeTier: unlike the others it is not a pure function of the
 * ticket. It reads an organization-level subscription map first and only falls
 * back to ticket tags. That makes it a join, not a per-row computation, so it
 * is modelled here as (orgSubscription, ticket) -> tier and will likely belong
 * on the organizations table rather than tickets.
 *
 * Mechanical de-DOM-ing only: functions that read globals now take arguments.
 */

// Field IDs, hardcoded in the original.
const REQUEST_TYPE_FIELD_ID = 22563831352855;
const FIRST_REPLY_FIELD_ID  = 35345064770327;
const RESOLUTION_FIELD_ID   = 35345460512663;

// iframe.html calculateSLAStatus. Minutes.
const SLA_TARGETS = {
  urgent: { firstReply: 15,   resolution: 240 },
  high:   { firstReply: 30,   resolution: 480 },
  normal: { firstReply: 60,   resolution: 4320 },
  low:    { firstReply: 1440, resolution: 7200 }
};

const ALARM_TAGS = ['alarmtraq', 'virsae', 'checkmk'];

function lowerTags(ticket) {
  if (!ticket.tags || !Array.isArray(ticket.tags)) return [];
  return ticket.tags.map(t => String(t).toLowerCase());
}

function findField(customFields, id) {
  if (!Array.isArray(customFields)) return undefined;
  return customFields.find(f => f && f.id === id);
}

/**
 * iframe.html extractRequestType.
 * Custom field wins; '-' is treated as unset. Falls back to tag-based alarm
 * detection in a fixed precedence: virsae, then alarmtraq, then checkmk.
 */
function extractRequestType(ticket) {
  const field = findField(ticket.custom_fields, REQUEST_TYPE_FIELD_ID);
  if (field && field.value && field.value !== '-') {
    return field.value;
  }

  const tags = lowerTags(ticket);
  if (tags.includes('virsae'))    return 'alarm_virsae';
  if (tags.includes('alarmtraq')) return 'alarm_alarmtraq';
  if (tags.includes('checkmk'))   return 'alarm_checkmk';

  return null;
}

/** Backs the Alarm filter, which tests each source independently. */
function extractAlarmFlags(ticket) {
  const tags = lowerTags(ticket);
  return {
    has_alarmtraq: tags.includes('alarmtraq'),
    has_virsae:    tags.includes('virsae'),
    has_checkmk:   tags.includes('checkmk')
  };
}

/**
 * iframe.html extractFirstReplyTimeFromMetrics, then the custom-field
 * fallback. metric_set is already in minutes; the custom field is in SECONDS.
 */
function extractFirstReplyTime(ticket) {
  // iframe.html extractFirstReplyTimeFromMetrics.
  // NOTE the `||`: a business time of 0 is falsy, so it falls through to
  // calendar. Preserved deliberately — this is what has been shipping.
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

/** Same shape as above, for full resolution time. */
function extractResolutionTime(ticket) {
  // Same business-or-calendar fallback as first reply.
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

/**
 * iframe.html calculateSLAStatus.
 *
 * Note the quirks, both preserved deliberately:
 *   - 'No Data' when BOTH measurements are missing, not when either is.
 *   - Starts at 'Met' and only downgrades, so a ticket with one measurement
 *     inside target and the other missing counts as Met.
 */
function calculateSLAStatus(ticket) {
  const firstReply = extractFirstReplyTime(ticket);
  const resolution = extractResolutionTime(ticket);

  if (!firstReply && !resolution) return 'No Data';

  const targets = SLA_TARGETS[ticket.priority || 'normal'] || SLA_TARGETS.normal;

  let status = 'Met';
  if (firstReply && firstReply > targets.firstReply) status = 'Missed';
  if (resolution && resolution > targets.resolution) status = 'Missed';
  return status;
}

/**
 * iframe.html detectVisualizeTierFromTags, plus the org-subscription lookup
 * that precedes it in processTickets().
 *
 * orgSubscription is whatever organizationSubscriptions.get(org.id) returned;
 * pass null when the org has none.
 */
function detectVisualizeTier(ticket, orgSubscription = null) {
  if (orgSubscription) return orgSubscription;

  if (!ticket || !ticket.tags || !Array.isArray(ticket.tags)) return null;
  const tags = lowerTags(ticket);

  if (tags.includes('visualize-premium')) return 'premium';
  if (tags.includes('visualize-plus') || tags.includes('visualize_plus')) return 'plus';
  if (tags.includes('visualize-basic')) return 'basic';
  return null;
}

/** Everything a sync-time port would need to write, in one call. */
function computeDerivedFields(ticket, orgSubscription = null) {
  const alarms = extractAlarmFlags(ticket);
  return {
    request_type_derived: extractRequestType(ticket),
    first_reply_minutes: extractFirstReplyTime(ticket),
    resolution_minutes: extractResolutionTime(ticket),
    sla_status: calculateSLAStatus(ticket),
    visualize_tier: detectVisualizeTier(ticket, orgSubscription),
    ...alarms
  };
}

module.exports = {
  REQUEST_TYPE_FIELD_ID,
  FIRST_REPLY_FIELD_ID,
  RESOLUTION_FIELD_ID,
  SLA_TARGETS,
  ALARM_TAGS,
  extractRequestType,
  extractAlarmFlags,
  extractFirstReplyTime,
  extractResolutionTime,
  calculateSLAStatus,
  detectVisualizeTier,
  computeDerivedFields
};
