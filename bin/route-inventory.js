#!/usr/bin/env node
'use strict';

/**
 * Stage 2's equivalent of baseline.json.
 *
 * Loads the Express app's routers and prints every route the application
 * actually serves, as a sorted METHOD + full-URL list. Capture it before
 * moving handlers between files, capture it after, and diff.
 *
 * An empty diff proves the consolidation changed no URLs — which is the whole
 * claim Stage 2 makes.
 *
 * It also flags duplicate route definitions, which are invisible at runtime:
 * Express silently uses the first and the rest are dead code.
 *
 * Usage:
 *   node bin/route-inventory.js                 # sorted list, stable for diffing
 *   node bin/route-inventory.js --by-file       # grouped by source router
 */

const path = require('path');

const BY_FILE = process.argv.includes('--by-file');

// Mount points as declared in index.js. Update if you change them there.
const MOUNTS = [
  ['/api',             './routes/api'],
  ['/api/analytics',   './routes/analytics'],
  ['/api/metrics',     './routes/metrics'],
  ['/admin/metrics',   './routes/metricsBackfill'],
  ['/api/auth',        './routes/auth']
];

function extractRoutes(router) {
  const out = [];
  const stack = (router && router.stack) || [];
  for (const layer of stack) {
    if (!layer.route) continue;
    const routePath = layer.route.path;
    const methods = Object.keys(layer.route.methods || {})
      .filter(m => m !== '_all')
      .map(m => m.toUpperCase());
    // Count non-terminal handlers as middleware (cacheMiddleware and friends).
    const handlerCount = (layer.route.stack || []).length;
    for (const method of methods) {
      out.push({ method, routePath, middleware: Math.max(0, handlerCount - 1) });
    }
  }
  return out;
}

function join(mount, routePath) {
  if (routePath === '/') return mount;
  return (mount + routePath).replace(/\/{2,}/g, '/');
}

const all = [];
const problems = [];

for (const [mount, modulePath] of MOUNTS) {
  let router;
  try {
    router = require(path.resolve(process.cwd(), modulePath));
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND' && err.message.includes(modulePath.replace('./', ''))) {
      problems.push(`not mounted / not found: ${modulePath}`);
    } else {
      problems.push(`${modulePath} failed to load: ${err.message}`);
    }
    continue;
  }

  for (const r of extractRoutes(router)) {
    all.push({
      method: r.method,
      url: join(mount, r.routePath),
      file: modulePath.replace('./routes/', ''),
      middleware: r.middleware
    });
  }
}

// Duplicates within a single router: Express uses the first, rest are dead.
const seenInFile = new Map();
for (const r of all) {
  const key = `${r.file} ${r.method} ${r.url}`;
  seenInFile.set(key, (seenInFile.get(key) || 0) + 1);
}

// Shadowing across routers: a longer mount is unreachable if a shorter mount
// already serves the same URL, because app.use matches in declaration order.
const byUrl = new Map();
for (const r of all) {
  const key = `${r.method} ${r.url}`;
  if (!byUrl.has(key)) byUrl.set(key, []);
  byUrl.get(key).push(r.file);
}

if (BY_FILE) {
  const files = [...new Set(all.map(r => r.file))].sort();
  for (const f of files) {
    const rs = all.filter(r => r.file === f)
      .sort((a, b) => (a.url + a.method).localeCompare(b.url + b.method));
    console.log(`\n${f}  (${rs.length} routes)`);
    for (const r of rs) {
      console.log(`  ${r.method.padEnd(6)} ${r.url}${r.middleware ? '   [+' + r.middleware + ' mw]' : ''}`);
    }
  }
  console.log('');
} else {
  // Stable sorted output, suitable for diffing across refactors.
  const lines = all
    .map(r => `${r.method.padEnd(6)} ${r.url}`)
    .sort();
  for (const l of lines) console.log(l);
}

// Findings go to stderr so they never pollute a diff of stdout.
const dupes = [...seenInFile.entries()].filter(([, n]) => n > 1);
const shadowed = [...byUrl.entries()].filter(([, files]) => new Set(files).size > 1);

if (dupes.length || shadowed.length || problems.length) {
  console.error('\n--- findings (stderr, not part of the diff) ---');
  for (const p of problems) console.error(`  note: ${p}`);
  for (const [key, n] of dupes) {
    console.error(`  DUPLICATE x${n}: ${key}  (Express serves the first; the rest are dead code)`);
  }
  for (const [key, files] of shadowed) {
    console.error(`  SHADOWED: ${key} defined in ${[...new Set(files)].join(' and ')}`);
  }
  console.error(`  total routes: ${all.length}`);
}
