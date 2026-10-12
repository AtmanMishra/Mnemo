# The website

`web/` is the project site: a Vite + React page, prerendered to static HTML at build time, served from
Vercel at <https://mnemo.atmanmishra.dev>, with DNS on Cloudflare. It replaces the old GitHub Pages site
in `site/` once the domain moves.

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
- Motion is loaded after hydration (GSAP + Lenis, one smooth-scroll engine, fine pointers only) and does not
  run under `prefers-reduced-motion`. The hero is `src/art/engram.ts`; the idea behind it is in
  `art/ENGRAM.md`.
- Headers (HSTS, a strict CSP with no inline script or style, no framing) are in `web/vercel.json`.

## Vercel

1. Add New → Project → import `AtmanMishra/Mnemo`. Root Directory: `web`. Framework preset: Vite.
2. Production Branch: `main` once `web` is merged (until then, set it to `web`).
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
