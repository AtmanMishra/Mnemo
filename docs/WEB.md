# The website

## Pages

One prerendered file per route (`web/src/routes.ts` is the list): `/`, `/features`, `/how-it-works`, `/download`, `/docs`, `/shortcuts`,
`/changelog`, `/roadmap`, `/security`, `/privacy`, `/terms`, plus `404.html`, `sitemap.xml`, the Atom feed
`/changelog.xml` and `/mnemo-commands-and-shortcuts.md`. `npm run build` ends with `scripts/check.mjs`, which fails on
a missing page, a wrong `<h1>` count, a duplicate title, a dead internal link or `#fragment`, or a page missing from the sitemap.

Content lives in `web/src/content/`, not in the pages:

- `changelog.ts`: **add an entry here for every release** (the page, the feed, the footer and download version all read it).
- `roadmap.ts`: the lanes on `/roadmap`. No dates, on purpose.
- `commands.ts`: the commands, keys and variables; keep it in step with `/help` and the app's key handlers.
- The privacy and terms pages are in `web/src/pages/`; have them reviewed before relying on them as legal text.

Download links point at `releases/latest/download/<asset>` (`mnemo-<platform>.tar.gz|zip`, `SHA256SUMS`), so they work
for any version once its release is published.

`web/` is the project site: a Vite + React page, prerendered to static HTML at build time, served from
Vercel at <https://mnemo.atmanmishra.dev>, with DNS on Cloudflare. It replaced the old GitHub Pages site in `site/`, which is now unused (as is `.github/workflows/pages.yml`).

## How it is built

- `npm run build` (in `web/`) typechecks, builds the client, builds the server entry, and
  `scripts/prerender.mjs` renders the page into `dist/index.html` and writes `dist/sitemap.xml`.
  Crawlers that do not run JavaScript, which is most AI crawlers, get the whole page.
- `scripts/installers.mjs` copies `app/scripts/get.sh` and `get.ps1` to `/install.sh` and `/install.ps1`
  before every build, so the one-liner, the release asset and the repository carry the same script.
  This reads outside `web/`, so the Vercel project must keep **Include source files outside of the Root
  Directory in the Build Step** on (the default).
- One section per feature in `web/src/sections/`, each with a working demo built from the app's own text (command and tool descriptions, the `--demo` turn, the gate's rules, the theme palettes). Interactive state is local; the server render and reduced motion show every demo in its finished state.
- Each feature is paired with a figure from [Hairline](https://hairline.lucasmarkes.com) (`@lucasmarkes/hairline`, MIT): isometric line drawings that answer the pointer, loaded only as they near the screen (`web/src/Figure.tsx`). They style themselves with constructable stylesheets, so the CSP needs no change, and draw with the page's colour tokens.
- Themes: light and dark tokens at the top of `web/src/styles.css`; the header toggle cycles system → light → dark, kept in `localStorage` and applied by `public/boot.js` before first paint.
- The look is mid-century print (cream and teal night, a red ribbon header, seals, ticket buttons) with
  self-hosted fonts from Fontsource. Pages are listed in `web/src/App.tsx`.
- The stage (`src/fx/stage.ts`, three.js, lazy loaded) is one WebGL canvas behind every page: Mne as voxels
  that come apart into a memory graph of six areas, drawn through a post pass (sunburst, pixelation, ASCII,
  grain). `src/fx/host.ts` points it at each page's `[data-stage-anchor]`; scroll scenes in `src/motion.ts`
  drive it. Without WebGL2 the page keeps its CSS sunburst and still images.
- The loader (`src/fx/boot.ts`) shows real progress (fonts, three.js, shader compile, graph, images) and
  hands its pixel elephant to the stage. It runs only when `public/boot.js` marks the first paint.
- `src/Router.tsx` swaps pages in the client behind a pixel wipe (`src/fx/transition.ts`); every page is
  still a prerendered file, so links work without JavaScript.
- Motion is loaded after hydration (GSAP + ScrollTrigger + Lenis, one smooth-scroll engine, fine pointers
  only) and does not run under `prefers-reduced-motion`.
- Headers (HSTS, a strict CSP with no inline script or style, no framing) are in `web/vercel.json`.

## Vercel

1. Add New → Project → import `AtmanMishra/Mnemo`. Root Directory: `web`. Framework preset: Vite.
2. Production Branch: `main`. Pull requests get a preview deployment.
3. Settings → Domains → add `mnemo.atmanmishra.dev`. Vercel shows the record to create; it is a CNAME.

## Cloudflare (DNS)

| Type | Name | Target | Proxy |
|------|------|--------|-------|
| CNAME | `mnemo` | `cname.vercel-dns.com` (use the exact value Vercel shows) | **DNS only** |

- Keep it **DNS only** (grey cloud). Vercel issues and renews the certificate, and proxying a Vercel
  site through Cloudflare adds a second CDN and a second TLS hop for no gain here. With DNS only,
  Cloudflare's WAF, Cache Rules and Page Rules do not apply to this hostname; Vercel's headers and cache
  do the work.
- Remove the old `mnemo → atmanmishra.github.io` record when you add this one (a name has one CNAME), and
  turn off GitHub Pages (Settings → Pages) and delete its custom domain.
- Turn on **DNSSEC** (DNS → Settings) and add the DS record at the registrar.
- Optional hardening: a CAA record naming the CA Vercel uses (check Vercel's docs for the current one)
  limits who can issue for the domain. Get it wrong and renewal fails, so add it only if you will check.
- Search Console and Bing Webmaster Tools verify with a TXT record; add it here, then submit
  `https://mnemo.atmanmishra.dev/sitemap.xml`.
- The Cloudflare skill's default for a brand-new static site is Workers + Static Assets, which would host the
  site on Cloudflare directly. Vercel was chosen here; moving later means changing the CNAME and nothing in
  `web/` except the headers file.

## SEO, answer engines and AI search

- One canonical URL, `robots.txt` that welcomes search and answer crawlers (named: `OAI-SearchBot`,
  `Claude-SearchBot`, `PerplexityBot`), `sitemap.xml`, Open Graph and Twitter tags, a 1200x630 `og.png`.
- Structured data (JSON-LD): `WebSite`, `Person` (the author), `SoftwareApplication` (free, Apache-2.0, three
  operating systems), `SoftwareSourceCode`, `WebPage` with `dateModified`. No ratings or reviews, since there
  are none. FAQPage markup is omitted on purpose: Google retired its rich result in 2026; the questions are
  plain headings with direct answers.
- Copy: the first paragraph answers "what is Mnemo" in under sixty words; headings are the questions people
  ask; claims carry their numbers and a link to the raw results.
- `llms.txt` is a courtesy for tools that read it. Google says it does not help or hurt rankings.
- `/.well-known/security.txt` points at the private advisory form.
- After deploy, check: view-source shows the h1, FAQ and JSON-LD; the Rich Results Test and Search
  Console's URL inspection render the page; `curl -A GPTBot -s https://mnemo.atmanmishra.dev/ | grep -c Mnemo`
  is non-zero.
