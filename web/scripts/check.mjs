// Checks the built site (dist/) the way a visitor or a crawler would meet it, and fails the
// build on: a missing page, a page without exactly one <h1>, a duplicate or missing title or
// description, an internal link to nowhere, a #fragment that names no id on its target page,
// a page missing from the sitemap, and placeholder text that should never ship.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const problems = [];
const fail = (m) => problems.push(m);

const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    statSync(p).isDirectory() ? walk(p) : files.push(p);
  }
})(dist);
const rel = (p) => "/" + p.slice(dist.length + 1).replaceAll("\\", "/");
const have = new Set(files.map(rel));

const pageFile = (path) => (path === "/" ? "/index.html" : `${path}/index.html`);
const routes = [...readFileSync(resolve(root, "src/routes.ts"), "utf8").matchAll(/path: "(\/[^"]*)"/g)].map((m) => m[1]);
if (routes.length < 5) fail("could not read the routes from src/routes.ts");

const html = {};
for (const r of routes) {
  if (!have.has(pageFile(r))) fail(`${r}: no prerendered page (${pageFile(r)})`);
  else html[r] = readFileSync(join(dist, pageFile(r)), "utf8");
}

const titles = new Map();
const ids = {};
for (const [r, h] of Object.entries(html)) {
  const body = h.slice(h.indexOf('<div id="root">'));
  const h1 = (body.match(/<h1[\s>]/g) || []).length;
  if (h1 !== 1) fail(`${r}: ${h1} <h1> elements (want 1)`);
  const title = h.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
  if (!title) fail(`${r}: no <title>`);
  if (titles.has(title)) fail(`${r}: same <title> as ${titles.get(title)}`);
  titles.set(title, r);
  if (!/<meta name="description" content="[^"]{40,}"/.test(h)) fail(`${r}: description missing or too short`);
  if (!h.includes(`<link rel="canonical" href="https://mnemo.atmanmishra.dev${r === "/" ? "/" : r}">`)) fail(`${r}: wrong canonical`);
  if (/undefined|\[object |NaN\b/.test(body.replace(/<script[\s\S]*?<\/script>/g, ""))) fail(`${r}: placeholder text (undefined / [object / NaN) in the page`);
  ids[r] = new Set([...h.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
}

const exists = (path) => have.has(path) || have.has(pageFile(path)) || have.has(`${path}.html`) || routes.includes(path);
// Paths Vercel serves from vercel.json rather than from dist.
const served = new Set(["/.well-known/security.txt"]);
for (const [r, h] of Object.entries(html)) {
  for (const m of h.matchAll(/\shref="([^"]*)"/g)) {
    const href = m[1].replaceAll("&amp;", "&");
    if (!href || /^(https?:|mailto:|data:)/.test(href)) continue;
    const [path, frag] = href.split("#");
    const target = path === "" ? r : path;
    if (!target.startsWith("/")) { fail(`${r}: relative link ${href}`); continue; }
    if (!served.has(target) && !exists(target)) { fail(`${r}: link to ${href} goes nowhere`); continue; }
    if (frag && routes.includes(target) && !ids[target]?.has(frag)) fail(`${r}: ${href} names no id on ${target}`);
  }
}

const sitemap = existsSync(join(dist, "sitemap.xml")) ? readFileSync(join(dist, "sitemap.xml"), "utf8") : "";
for (const r of routes) if (!sitemap.includes(`<loc>https://mnemo.atmanmishra.dev${r === "/" ? "/" : r}</loc>`)) fail(`${r}: missing from sitemap.xml`);
for (const f of ["/404.html", "/changelog.xml", "/install.sh", "/install.ps1", "/mnemo-commands-and-shortcuts.md", "/robots.txt", "/.well-known/security.txt"]) if (!have.has(f)) fail(`${f}: missing from dist`);

// The home page's highlights: five features, each a tab, and the first demo rendered without JavaScript.
const home = html["/"] ?? "";
const tabs = (home.match(/id="hl-tab-/g) || []).length;
if (tabs !== 5) fail(`/: ${tabs} highlight tabs (want 5)`);
if (!home.includes('id="hl-panel"') || !home.includes("TASK.md")) fail("/: the first highlight's demo did not render on the server");

if (problems.length) {
  console.error(`site check failed (${problems.length}):\n - ${problems.join("\n - ")}`);
  process.exit(1);
}
console.log(`site check passed: ${routes.length} pages, ${titles.size} distinct titles, links and fragments resolve`);
