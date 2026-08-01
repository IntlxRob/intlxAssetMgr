#!/usr/bin/env node
'use strict';

/**
 * The decisive step. Field IDs are meaningless without their titles, and the
 * titles only live in Zendesk.
 *
 * Lists every ticket field with its ID, title, and type, highlighting anything
 * whose title suggests billing — which is what the legacy frontend was fuzzy-
 * matching against at runtime. Reuses the same credentials syncJobs.js already
 * has, so there is nothing new to configure.
 *
 * Usage:
 *   node bin/zendesk-fields.js            # highlight billing-ish fields
 *   node bin/zendesk-fields.js --all      # dump every field
 *   node bin/zendesk-fields.js 21223282485911 18337413339543   # look up specific IDs
 */

require('dotenv').config();
const axios = require('axios');

const SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const EMAIL = process.env.ZENDESK_EMAIL;
const TOKEN = process.env.ZENDESK_API_TOKEN;

if (!SUBDOMAIN || !EMAIL || !TOKEN) {
  console.error('Missing Zendesk credentials. Expected ZENDESK_SUBDOMAIN, ZENDESK_EMAIL,');
  console.error('ZENDESK_API_TOKEN — the same ones services/syncJobs.js already uses.');
  console.error('Run this from the repo root so .env is picked up.');
  process.exit(1);
}

const AUTH = Buffer.from(`${EMAIL}/token:${TOKEN}`).toString('base64');
const BASE = `https://${SUBDOMAIN}.zendesk.com/api/v2`;

const ALL = process.argv.includes('--all');
const WANTED = process.argv.slice(2).filter(a => /^\d+$/.test(a)).map(Number);

// The exact terms the legacy frontend matched on, in findBillableField().
const LEGACY_TERMS = ['billable', 'bill', 'chargeable', 'invoiceable'];

async function main() {
  let fields = [];
  let url = `${BASE}/ticket_fields.json?per_page=100`;

  process.stdout.write('Fetching ticket fields');
  while (url) {
    const { data } = await axios.get(url, {
      headers: { Authorization: `Basic ${AUTH}`, 'Content-Type': 'application/json' }
    });
    fields = fields.concat(data.ticket_fields || []);
    url = data.next_page;
    process.stdout.write('.');
  }
  console.log(` ${fields.length} found.\n`);

  const byId = new Map(fields.map(f => [f.id, f]));

  if (WANTED.length) {
    console.log('='.repeat(72));
    console.log('REQUESTED FIELDS');
    console.log('='.repeat(72));
    for (const id of WANTED) {
      const f = byId.get(id);
      if (!f) { console.log(`  ${id}  — NOT FOUND in this Zendesk instance`); continue; }
      console.log(`\n  id     ${f.id}`);
      console.log(`  title  ${f.title}`);
      console.log(`  type   ${f.type}`);
      console.log(`  active ${f.active}`);
      if (f.custom_field_options && f.custom_field_options.length) {
        console.log('  options:');
        for (const o of f.custom_field_options.slice(0, 12)) {
          console.log(`      ${String(o.value).padEnd(28)} ${o.name}`);
        }
      }
    }
    console.log('');
  }

  // What the legacy runtime search would have found, in API order.
  const matches = fields.filter(f =>
    LEGACY_TERMS.some(t => (f.title || '').toLowerCase().includes(t))
  );

  console.log('='.repeat(72));
  console.log('WHAT THE LEGACY FUZZY MATCH WOULD HAVE PICKED');
  console.log('='.repeat(72));
  if (!matches.length) {
    console.log('\n  NOTHING MATCHED.');
    console.log('  findBillableField() would leave billableFieldId = null, and');
    console.log('  extractBillableStatus() returns false for every ticket.');
    console.log('  That would mean nothing has ever been marked billable by this path.\n');
  } else {
    console.log(`\n  ${matches.length} field(s) match ${LEGACY_TERMS.join(' / ')}.`);
    console.log('  The legacy code took .find() — the FIRST of these in API order:\n');
    matches.forEach((f, i) => {
      const flag = i === 0 ? '  <-- this one won' : '';
      console.log(`    ${String(f.id).padEnd(18)} ${String(f.type).padEnd(12)} ${f.title}${flag}`);
    });
    if (matches.length > 1) {
      console.log('\n  More than one match: which one won depended on Zendesk\'s ordering.');
      console.log('  This is exactly the ambiguity we are replacing with a pinned ID.');
    }
    console.log('');
  }

  if (ALL) {
    console.log('='.repeat(72));
    console.log('ALL TICKET FIELDS');
    console.log('='.repeat(72));
    console.log('  ' + 'id'.padEnd(18) + 'type'.padEnd(14) + 'active'.padEnd(9) + 'title');
    console.log('  ' + '-'.repeat(68));
    for (const f of fields) {
      console.log(
        '  ' + String(f.id).padEnd(18) +
        String(f.type).padEnd(14) +
        String(f.active).padEnd(9) +
        f.title
      );
    }
    console.log('');
  } else {
    console.log('Run with --all to list every field.\n');
  }
}

main().catch(err => {
  const status = err.response?.status;
  if (status === 401 || status === 403) {
    console.error('\nZendesk rejected the credentials (HTTP ' + status + ').');
    console.error('Check ZENDESK_EMAIL and ZENDESK_API_TOKEN, and that API token access is enabled.');
  } else {
    console.error('\nFailed:', err.message);
  }
  process.exit(1);
});
