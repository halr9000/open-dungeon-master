// The JavaScript and CSS a route's first load costs, from a production
// build's own manifests, held against scripts/bundle-budget.json (audit P15).
// Fails when a route grows past its budget, so a change that pulls a heavy
// system into a page's first load is noticed when it is made rather than
// found later. Run after `npm run build`: node scripts/check-bundle-budget.mjs
// (add --write to print the current numbers as a starting budget).
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const root = path.join(import.meta.dirname, "..");
const next = path.join(root, ".next");
const budgets = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "bundle-budget.json"), "utf8"));
const build = JSON.parse(fs.readFileSync(path.join(next, "build-manifest.json"), "utf8"));
const shared = [...(build.polyfillFiles ?? []), ...(build.rootMainFiles ?? [])];

const sizes = new Map();
function measure(file) {
  if (!sizes.has(file)) {
    const bytes = fs.readFileSync(path.join(next, file));
    sizes.set(file, { raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length });
  }
  return sizes.get(file);
}

function routeFiles(page) {
  const manifest = path.join(next, "server", "app", `${page}_client-reference-manifest.js`);
  if (!fs.existsSync(manifest)) throw new Error(`No build manifest for ${page}: was the route renamed? Update scripts/bundle-budget.json.`);
  globalThis.__RSC_MANIFEST = {};
  // The manifest is a script that assigns itself to globalThis.__RSC_MANIFEST.
  new Function(fs.readFileSync(manifest, "utf8"))();
  const entry = Object.values(globalThis.__RSC_MANIFEST)[0];
  const js = new Set(shared);
  const css = new Set();
  for (const files of Object.values(entry.entryJSFiles ?? {})) for (const file of files) js.add(file);
  for (const files of Object.values(entry.entryCSSFiles ?? {})) for (const file of files) if (!file.inlined) css.add(file.path);
  return { js: [...js], css: [...css] };
}

const kib = (bytes) => Math.round(bytes / 102.4) / 10;
const write = process.argv.includes("--write");
const problems = [];
const current = {};
for (const [page, budget] of Object.entries(budgets.routes)) {
  const { js, css } = routeFiles(page);
  const sum = (files) => files.reduce((total, file) => total + measure(file).gzip, 0);
  const now = { jsGzipKiB: kib(sum(js)), cssGzipKiB: kib(sum(css)), scripts: js.length };
  current[page] = now;
  console.log(`${page}: ${now.scripts} scripts, ${now.jsGzipKiB} KiB JS gzip (budget ${budget.jsGzipKiB}), ${now.cssGzipKiB} KiB CSS gzip (budget ${budget.cssGzipKiB})`);
  if (now.jsGzipKiB > budget.jsGzipKiB) problems.push(`${page} loads ${now.jsGzipKiB} KiB of JS (gzip), over its ${budget.jsGzipKiB} KiB budget`);
  if (now.cssGzipKiB > budget.cssGzipKiB) problems.push(`${page} loads ${now.cssGzipKiB} KiB of CSS (gzip), over its ${budget.cssGzipKiB} KiB budget`);
}
if (write) console.log(JSON.stringify(current, null, 2));
if (problems.length) {
  for (const problem of problems) console.error(`budget: ${problem}`);
  console.error("If the growth is wanted, raise the budget in scripts/bundle-budget.json in the same change and say why.");
  process.exit(1);
}
