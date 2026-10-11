// Prerenders the page into dist/index.html so crawlers that do not run JavaScript (most
// AI crawlers fetch raw HTML) see the whole page. Also writes sitemap.xml, so its
// lastmod is the build date. Run by `npm run build` after the client and SSR builds.
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { render } = await import(pathToFileURL(resolve(root, "dist-ssr/entry-server.js")).href);
const { html, jsonLd } = render();

const indexPath = resolve(root, "dist/index.html");
let page = readFileSync(indexPath, "utf8");
for (const marker of ["<!--app-->", "<!--jsonld-->"]) {
  if (!page.includes(marker)) throw new Error(`dist/index.html has no ${marker}`);
}
page = page.replace("<!--app-->", () => html).replace("<!--jsonld-->", () => `<script type="application/ld+json">${jsonLd}</script>`);
writeFileSync(indexPath, page);

const site = "https://mnemo.atmanmishra.dev";
const date = new Date().toISOString().slice(0, 10);
writeFileSync(
  resolve(root, "dist/sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${site}/</loc><lastmod>${date}</lastmod></url>\n</urlset>\n`,
);
rmSync(resolve(root, "dist-ssr"), { recursive: true, force: true });
console.log(`prerendered ${html.length} bytes of HTML, sitemap lastmod ${date}`);
