const fs = require('fs');

const SIPORTAL_API_KEY = process.env.SIPORTAL_API_KEY;
const BASE_URL = 'https://www.siportal.net/api/2.0';

const HEADERS = {
  'Authorization': SIPORTAL_API_KEY,
  'Content-Type': 'application/json'
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWithRetry(url, retries = 10, delayMs = 5000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`  [attempt ${attempt}] GET ${url}`);
      const res = await fetch(url, { headers: HEADERS });
      return res;
    } catch (err) {
      if (attempt === retries) {
        console.error(`  Failed after ${retries} attempts: ${err.message}`);
        throw err;
      }
      console.log(`  Network error (${err.code || err.message}), waiting ${delayMs / 1000}s before retry ${attempt + 1}/${retries}...`);
      await sleep(delayMs);
    }
  }
}

async function fetchAllCompanies() {
  let allCompanies = [];
  const seenIds = new Set();
  let offset = 0;
  const limit = 20;

  while (true) {
    const url = `${BASE_URL}/companies?offset=${offset}&limit=${limit}`;
    console.log(`\nRequesting companies at offset ${offset}...`);

    let res;
    try {
      res = await fetchWithRetry(url);
    } catch (err) {
      console.error(`Giving up on companies at offset ${offset}`);
      break;
    }

    if (!res.ok) { console.error(`Companies API error: ${res.status}`); break; }

    const data = await res.json();
    const companies = data.data?.results || data.results || data.data || [];

    if (!Array.isArray(companies) || companies.length === 0) {
      console.log('No more companies.');
      break;
    }

    const firstId = companies[0]?.id;
    if (seenIds.has(firstId)) {
      console.log(`Duplicate detected at offset ${offset} — stopping.`);
      break;
    }

    for (const c of companies) {
      if (!seenIds.has(c.id)) { seenIds.add(c.id); allCompanies.push(c); }
    }

    console.log(`Offset ${offset}: total companies so far: ${allCompanies.length}`);

    if (companies.length < limit) { console.log('Last page of companies.'); break; }

    offset += limit;
    await sleep(500);
  }

  return allCompanies;
}

async function fetchAllDevices() {
  let allDevices = [];
  const seenIds = new Set();
  let offset = 0;
  const limit = 20;

  while (true) {
    const url = `${BASE_URL}/devices?offset=${offset}&limit=${limit}`;
    console.log(`\nFetching devices at offset ${offset}... (total so far: ${allDevices.length})`);

    let res;
    try {
      res = await fetchWithRetry(url);
    } catch (err) {
      console.error(`Giving up on devices at offset ${offset}`);
      break;
    }

    if (!res.ok) { console.error(`Devices API error: ${res.status}`); break; }

    const data = await res.json();
    const devices = data.data?.results || data.results || data.data || [];

    if (!Array.isArray(devices) || devices.length === 0) {
      console.log('No more devices.');
      break;
    }

    const firstId = devices[0]?.id;
    if (seenIds.has(firstId)) {
      console.log(`Duplicate detected at offset ${offset} — stopping.`);
      break;
    }

    for (const d of devices) {
      if (!seenIds.has(d.id)) { seenIds.add(d.id); allDevices.push(d); }
    }

    // Do NOT use API total — it's inaccurate. Only stop on empty page or duplicate.
    if (devices.length < limit) { console.log('Last page of devices.'); break; }

    offset += limit;
    await sleep(500);
  }

  return allDevices;
}

function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCSV(assets) {
  const headers = [
    'Company Name', 'Company ID', 'Asset Tag', 'Name',
    'Host Name', 'IP Address', 'Serial Number', 'Type', 'Status',
    'Description', 'Location', 'Assigned User'
  ];

  const rows = assets.map(a => [
    a.company_name, a.company_id, a.asset_tag, a.name,
    a.host_name, a.ip_address, a.serial_number, a.type, a.status,
    a.description, a.location, a.assigned_user
  ].map(escapeCSV).join(','));

  return [headers.join(','), ...rows].join('\n');
}

async function exportBILHAssets() {
  console.log('=== STARTING EXPORT ===\n');

  // Step 1: Get all companies and find BILH ones
  const allCompanies = await fetchAllCompanies();
  console.log(`\nTotal unique companies fetched: ${allCompanies.length}`);

  const bilhCompanies = allCompanies.filter(c =>
    c.name?.toUpperCase().startsWith('BILH')
  );

  console.log(`\nFound ${bilhCompanies.length} BILH companies:`);
  bilhCompanies.forEach(c => console.log(` - ${c.name} (ID: ${c.id})`));

  if (bilhCompanies.length === 0) {
    console.log('\nNo BILH companies found.');
    return;
  }

  const bilhCompanyIds = new Set(bilhCompanies.map(c => c.id));
  const bilhCompanyMap = Object.fromEntries(bilhCompanies.map(c => [c.id, c.name]));

  // Step 2: Fetch ALL devices once, then filter client-side
  console.log('\nFetching ALL devices (will filter for BILH companies)...');
  const allDevices = await fetchAllDevices();
  console.log(`\nTotal unique devices fetched: ${allDevices.length}`);

  // DEBUG - search for IXM devices regardless of company
  const ixmDevices = allDevices.filter(d =>
    d.type?.name?.toLowerCase().includes('ixm') ||
    d.name?.toLowerCase().includes('ixm') ||
    d.description?.toLowerCase().includes('ixm')
  );
  console.log(`\nIXM devices found in full dataset: ${ixmDevices.length}`);
  ixmDevices.forEach(d => console.log(`  - "${d.name}" | company: ${JSON.stringify(d.company)} | type: ${d.type?.name}`));

  // Step 3: Filter devices belonging to BILH companies
  const bilhDevices = allDevices.filter(d => {
    const companyId = d.company?.id || d.companyId || d.company_id;
    return bilhCompanyIds.has(companyId);
  });

  console.log(`\nBILH devices found: ${bilhDevices.length}`);

  // Breakdown per company
  const countByCompany = {};
  for (const d of bilhDevices) {
    const companyId = d.company?.id || d.companyId || d.company_id;
    const name = bilhCompanyMap[companyId] || `Unknown (${companyId})`;
    countByCompany[name] = (countByCompany[name] || 0) + 1;
  }

  console.log('\nDevice count per BILH company:');
  Object.entries(countByCompany)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([name, count]) => console.log(`  ${name}: ${count} devices`));

  // Flag any BILH companies with 0 devices
  const companiesWithDevices = new Set(Object.keys(countByCompany));
  const missingCompanies = bilhCompanies.filter(c => !companiesWithDevices.has(c.name));
  console.log('\nBILH companies with 0 devices:');
  if (missingCompanies.length === 0) {
    console.log('  None — all BILH companies have at least 1 device.');
  } else {
    missingCompanies.forEach(c => console.log(`  - ${c.name} (ID: ${c.id})`));
  }

  const allAssets = bilhDevices.map(device => {
    const companyId = device.company?.id || device.companyId || device.company_id;
    return {
      company_name: bilhCompanyMap[companyId] || device.company?.name || '',
      company_id: companyId,
      asset_tag: device.tag,
      name: device.name,
      host_name: device.hostName || device.hostname,
      ip_address: device.ips?.length > 0 ? device.ips.map(i => i.ip).filter(Boolean).join(' | ') : '',
      serial_number: device.serial,
      type: device.type?.name,
      status: device.status,
      description: device.description,
      location: device.location,
      assigned_user: device.contact?.name || '',
    };
  });

  const csv = toCSV(allAssets);
  const filename = `bilh_assets_export_${new Date().toISOString().slice(0, 10)}.csv`;
  fs.writeFileSync(filename, csv);

  console.log(`\n✅ Total assets exported: ${allAssets.length}`);
  console.log(`Saved to ${filename}`);
}

exportBILHAssets().catch(err => {
  console.error('\n=== UNHANDLED ERROR ===');
  console.error(err);
});