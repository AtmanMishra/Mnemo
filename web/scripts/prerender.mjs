// Prerenders every page into dist/ so crawlers that do not run JavaScript (most AI
// crawlers fetch raw HTML) see the whole site: / -> dist/index.html, /docs ->
// dist/docs/index.html, and an unknown path -> dist/404.html. Also writes sitemap.xml, the
// changelog's Atom feed and a Markdown copy of the commands. Run by `npm run build` after
// the client and SSR builds; scripts/check.mjs then checks the result.
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { render, data } = await import(pathToFileURL(resolve(root, "dist-ssr/entry-server.js")).href);
const SITE = "https://mnemo.atmanmishra.dev";
const today = new Date().toISOString().slice(0, 10);

const template = readFileSync(resolve(root, "dist/index.html"), "utf8");
for (const marker of ["<!--app-->", "<!--jsonld-->"]) {
  if (!template.includes(marker)) throw new Error(`dist/index.html has no ${marker}`);
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const full = (r) => (r.path === "/" ? r.title : `${r.title} · Mnemo`);

/** The template with this page's head tags and body. */
function page(route, path, { noindex = false } = {}) {
  const { html, jsonLd } = render(path);
  const url = `${SITE}${route.path === "/" ? "/" : route.path}`;
  const set = (re, to) => {
    if (!re.test(out)) throw new Error(`template lacks ${re}`);
    out = out.replace(re, () => to);
  };
  let out = template;
  set(/<title>[^<]*<\/title>/, `<title>${esc(full(route))}</title>`);
  set(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(route.description)}">`);
  set(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${url}">`);
  set(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(full(route))}">`);
  set(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(route.description)}">`);
  set(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${url}">`);
  if (noindex) set(/<meta name="robots" content="[^"]*">/, `<meta name="robots" content="noindex">`);
  return out.replace("<!--app-->", () => html).replace("<!--jsonld-->", () => `<script type="application/ld+json">${jsonLd}</script>`);
}

let bytes = 0;
for (const route of data.routes) {
  const file = route.path === "/" ? "index.html" : `${route.path.slice(1)}/index.html`;
  const out = resolve(root, "dist", file);
  mkdirSync(dirname(out), { recursive: true });
  const html = page(route, route.path);
  writeFileSync(out, html);
  bytes += html.length;
}

// The page served for an unknown address. Its path is one no route matches, so the app draws the not-found page.
writeFileSync(
  resolve(root, "dist/404.html"),
  page({ path: "/404", title: "Not found", description: "This page does not exist. Mne looked and does not remember it." }, "/404", { noindex: true }),
);

writeFileSync(
  resolve(root, "dist/sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    data.routes.map((r) => `  <url><loc>${SITE}${r.path === "/" ? "/" : r.path}</loc><lastmod>${today}</lastmod><priority>${r.priority}</priority></url>`).join("\n") +
    `\n</urlset>\n`,
);

// Atom feed of the changelog.
const kinds = { added: "Added", changed: "Changed", fixed: "Fixed", security: "Security", removed: "Removed" };
const entry = (r) => {
  const body =
    `<p>${esc(r.headline)}</p>` +
    Object.entries(kinds)
      .map(([k, label]) => {
        const list = r.changes.filter((c) => c.kind === k);
        return list.length ? `<h3>${label}</h3><ul>${list.map((c) => `<li><strong>${esc(c.text)}</strong>${c.detail ? ` &#8212; ${esc(c.detail)}` : ""}</li>`).join("")}</ul>` : "";
      })
      .join("") +
    (r.known?.length ? `<h3>Known issues</h3><ul>${r.known.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : "");
  return (
    `  <entry>\n    <id>tag:mnemo.atmanmishra.dev,${r.date}:v${r.version}</id>\n    <title>Mnemo ${r.version}</title>\n` +
    `    <updated>${r.date}T00:00:00Z</updated>\n    <link rel="alternate" href="${SITE}/changelog#v${r.version}"/>\n` +
    `    <summary>${esc(r.headline)}</summary>\n    <content type="html">${esc(body)}</content>\n  </entry>`
  );
};
writeFileSync(
  resolve(root, "dist/changelog.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n  <id>${SITE}/changelog</id>\n  <title>Mnemo changelog</title>\n` +
    `  <updated>${data.releases[0].date}T00:00:00Z</updated>\n  <link rel="self" href="${SITE}/changelog.xml"/>\n  <link rel="alternate" href="${SITE}/changelog"/>\n` +
    `  <author><name>Atman Mishra</name></author>\n${data.releases.map(entry).join("\n")}\n</feed>\n`,
);

// The commands and shortcuts as one Markdown file, for people who want it offline.
const md =
  `# Mnemo: commands and shortcuts\n\nMnemo ${data.releases[0].version}. Type \`/\` in the prompt for the command menu, or \`/help\` for the same list in the app.\n` +
  `The current version of this list is at ${SITE}/shortcuts.\n\n` +
  data.groups
    .map((g) => `## ${g.title}\n\n${g.intro ? g.intro + "\n\n" : ""}| ${g.id === "env" ? "Variable" : g.id === "slash" || g.id === "cli" ? "Command" : "Key"} | What it does |\n|---|---|\n` +
      g.rows.map(([k, d]) => `| ${k.replace(/\|/g, "\\|")} | ${d.replace(/\|/g, "\\|")} |`).join("\n") + `\n${g.after ? "\n" + g.after + "\n" : ""}`)
    .join("\n");
writeFileSync(resolve(root, "dist/mnemo-commands-and-shortcuts.md"), md);

rmSync(resolve(root, "dist-ssr"), { recursive: true, force: true });
console.log(`prerendered ${data.routes.length} pages (${bytes} bytes), 404, sitemap, feed (${data.releases.length} releases), commands.md; lastmod ${today}`);
