# Research Report: DeepSeek Harness + Scrapling

Date: 2026-08-25
Scope: (A) DeepSeek Harness (`dsh`) docs site + GitHub repo, focusing on what a "harness" is, dynamic composition, Python SDK surface, and how skills/tools attach to agents. (B) Scrapling: docs, install verification, and runnable example scripts.

---

## Part A — DeepSeek Harness (`deepseek-ai/deepseek-harness`)

Sources:
- Docs: https://deepseek-harness.github.io/deepseek-harness/en/ (84 pages crawled: guides, reference, subsystems, cookbooks, Cordis tutorial)
- Repo: https://github.com/deepseek-ai/deepseek-harness (README, python/sdk/README.md)
- Status: **developer preview**; compatibility-breaking changes expected. MIT licensed.

### A1. What a "harness" is here

DeepSeek Harness (`dsh`) is a full agent *runtime*, not just a chat loop. The running system contains: model adapters, the tool registry, the append-only session log, persistence backends, sandbox/approval policy, settings/credentials, telemetry, the agent loop itself, plus a Web UI or headless runner. Its core design rule: **everything is a plugin**, built on the vendored [Cordis](https://github.com/cordiverse/cordis) framework. There is "no privileged core to patch" — every part (including the agent loop and the model adapter) is a replaceable plugin mounted beside the others.

Cordis in five ideas (from the primer):
1. A **plugin** implements `Service` (function with optional `inject`/`apply(ctx)` or a Service subclass).
2. A **context** is a repository of services; each claims a stable key (`ctx.tools`, `ctx.llm`, `ctx.sessions`, ...).
3. Dependencies declared via `inject`; a plugin waits until required services exist (missing ones sit silently PENDING forever — a known diagnostic trap).
4. Typed **events** (`emit`, `waterfall`, `parallel`, `serial`) are the extension points across three domains: durable session events, live `agent/*` events, and capability events (`fs/*`, `tools/*`, ...).
5. Registrations are **reversible effects**: prompt sections, tool schemas, adapters, listeners all unwind predictably on unload/reload.

Turn flow: a *turn* opens on input claim, each *step* = one model request + the tools it calls; prompt sections and tool schemas are assembled per step from registered plugins. Key invariant: **"Model-visible means logged"** — anything reaching a model request must be reconstructable from the append-only session log (enforced by a runtime invariant).

### A2. How harnesses are created dynamically (composition)

A boot is a **plugin tree composed at boot from ordered layers**:
1. Each bundle listed in a **profile** (`web`, `headless` ship as templates).
2. Profile-level `cordis.patch.yml`.
3. Home-level `cordis.patch.yml`.
4. Any `--patch` overlay.

A patch targets a config row by stable `id` and replaces its whole config or inserts new rows. Inspect what your machine actually boots with `dsh --profile web --dump-config`. So a new "harness" variant is data: stack bundles + write patches; no code fork needed.

Additional dynamic-composition machinery:
- **Config entries**: `id` (stable identity so edits ≠ remove+add), `disabled: true` (unmount without deleting), nested groups, and `isolate` — a group gets its own instance of a service name, so two groups can see differently configured shells.
- **HMR**: `@deepseek-ai/cordis-plugin-hmr` watches files; editing a plugin source or `cordis.yml` itself unloads old effects and loads new code live (loader diffs entries by id).
- **Agent presets**: "give one session a different capability set — compose an agent preset; a service row there needs an `isolate` realm."
- **Scoped registration** (`dsh-scope`): registries (skills, tools) have a global layer plus per-agent/per-preset scope layers; nearest layer wins duplicate names; re-parenting a scope (blank-session recompose) is visible on next read. This is the mechanism for per-agent capability differentiation at runtime.

### A3. Capability seams: how tools/skills attach

The recurring pattern is the **three-role capability design** (a "seam"): *Service Definition* (interface on a `ctx.*` key) + one-or-more *Service Providers* (implementations swapped purely by config) + *Consumer* (the model-facing tool). Provider and Consumer never depend on each other. Canonical example — Bash:
- Definition `dsh-shell` (`ctx.shell`), Provider `dsh-bash-local`, Consumer `dsh-tool-bash`.

Other seams: `ctx.llm` (llm-deepseek / llm-pi-ai / llm-replay), `ctx.subagents` (named-provider registry: spawn-in-process, fork, acp, codex, claude-code, dsh-sdk), `ctx.codeRuntime`, `ctx.workflowEngine`, `ctx.skills`, filesystem/subprocess/terminals/sessionPersistence/settings/credentials/storage, etc. Pointing fs+subprocess at a remote sandbox moves Bash, PTY, and LSP together — one provider swap changes execution world.

**Tool attachment** (`ctx.tools`): a tool is a `ToolDefinition` = model-facing `ToolSchema` + mandatory canonical `output.schema` + typed `render` projection + `execute(args, exec)` + optional `finalizeContent`, `timeoutMs` (cooperative, enforced by a wrapper, never sent to model), `isConcurrencySafe(args)` (parallel dispatch opt-in), and UI presenters. First-party tools use `defineTool`, which validates/narrows model args against the schema DSL before execute runs. Registration is effect-based: **disposing the owning plugin fiber unregisters the tool**, and schemas flow into system-prompt assembly automatically. Hot-swapping a tool = dispose its effect, register replacement. Only `name/description/parameters` are whitelisted into model requests.

**Skill attachment** (`ctx.skills`): a layered provider registry (host + per-scope layers). Providers implement `list(options) -> candidates | SkillProviderObservation` and `get(candidate, options)`; shipped local provider scans ranked roots: `<project>/.dsh/skills` (100), `<project>/.agents/skills` (200), custom dirs (300), user `~/.dsh/skills` (400), `~/.agents/skills` (500), bundled dir (600). Skills are `<name>/SKILL.md` bundles or flat `<name>.md` (kebab-case names). Chokidar watches roots; **model-facing write/edit observations synchronously invalidate the catalog**, so a skill written during a session becomes loadable immediately. Consumer `dsh-tool-skill` owns the model-facing `skill` tool and initial/replacement catalogs.

### A4. Self-modification / dynamic capability creation

No single "the model writes its own tools" feature, but four adjacent mechanisms:
1. **Code Runtime seam** (`ctx.codeRuntime`): runs a model-written program as an async function body with host functions injected as global binding namespaces; returns `{ value?, logs[], error? }` (error is a field, not a rejection). Effectively dynamic tool creation per call.
2. **Workflow seam** (`ctx.workflowEngine`): runs a model-written orchestration script (worker-thread vm) whose `agent()` calls spawn real subagents through the subagent seam; meta/args are validated JSON, script cannot touch policy.
3. **Skills hot-reload**: because skill roots are watched and write/edit invalidates caches, an agent can add `SKILL.md` files mid-session and use them via the `skill` tool — self-extension through files rather than code registration.
4. **Plugin HMR + patches**: out-of-band, a human/agent editing plugin code or cordis.yml changes the live harness without restart.

### A5. Python SDK surface (`deepseek-harness-sdk` on PyPI; import `deepseek_harness`)

Architecture: thin Python wrapper over a **bundled runtime subprocess speaking JSON-RPC over stdio**. Installing the SDK installs the same-version `deepseek-harness-runtime-bin` platform wheel (single-file `dsh-jsonrpc-agent` executable; no Node.js needed at runtime). Requirements: Python ≥3.10; macOS 14+ arm64 / Linux x64|arm64; POSIX only (persistent PTY needs a terminal substrate; no Windows agents).

High-level API:
```python
from pathlib import Path
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness(
    provider="deepseek-official",      # route registered by the chosen Cordis composition
    model="deepseek-v4-flash",         # resolved by that adapter
    max_tokens=49_152,
    cwd="/abs/workspace",              # workspace the agent may modify
    session_root="/abs/sessions",      # JSONL session logs/state (sets DSH_SESSION_ROOT)
    cordis="path/to/composition.cordis.yml",  # omit for bundled default composition
) as harness:
    result = harness.run("task text", session_id="example-001")
    print(result.final_response)
```
- `DeepSeekHarness` lazily starts the runtime and **reuses it until the context manager exits**. Reusing the same `session_id` continues the same durable conversation including the session-owned Bash process (cwd, exported vars, shell functions); fresh id = independent task.
- `run()` → `RunResult(session_id, final_response, finish_reason, events, notifications, session_root)`. `finish_reason` is the `kind` of the last root `turn/end` (`completed`, `max-tokens`, `error`, None if no turn ended). Protocol violations raise `SdkProtocolError`. `Session.run()` owns an activity interval from durable inbox receipt of the prompt to whole-agent idle; steering/injected context can land inside it.
- Low level: `HarnessClient` (start/launch control, retains discovered subagent ancestry, `on_notification` sees root + descendant notifications in wire order) and `session_prompt()` returning the queued `MessageId` immediately (caller then owns the activity boundary).
- Runtime selection env: `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` (OpenAI-compatible proxies OK), `DSH_MODEL`, `DSH_SYSTEM_PROMPT`, `DSH_SESSION_ROOT`, `DSH_CORDIS_CONFIG` (config injection happens in `HarnessClient.start()`; explicit `runtime_bin`/`bridge_bin`/`launch_args_override` disables injection).
- **Bundled default composition**: model-facing tools are persistent `bash` (300 s timeout) and `str_replace_editor` (16,000-char output limit) ONLY; compaction disabled; bare local filesystem backend (absolute paths reach anything the process can see); `danger-full-access` sandbox policy — run only in disposable checkouts/containers; uncompressed JSONL sessions; sandbox-policy facts logged as runtime user context, not appended to system prompt. Custom compositions must keep the `@deepseek-ai/dsh-sdk-jsonrpc-server` entry.

### A6. Relevance to our self-evolving agent project

- The three-role seam pattern (definition/provider/consumer) + effect-based registration is a clean blueprint for swappable capabilities in our own harness.
- Per-scope registry layers + agent presets = principled way to give each subagent a different toolset without process isolation.
- Watched skill directories with write-triggered cache invalidation = practical, simple self-extension channel (we already mirror this in our own harness state).
- The Python SDK shows the minimal viable remote-control surface: spawn a bundled runtime, one `run()` call, JSONL logs, session reuse semantics.
- The "model-visible means logged" invariant is a strong correctness rule worth adopting for any prompt/context mutation.

---

## Part B — Scrapling (`D4Vinci/Scrapling`)

Sources: GitHub README (main branch), https://scrapling.readthedocs.io (fetching, parsing/adaptive, spiders/sessions pages). Version tested: **0.4.15**.

### B1. What it is

An adaptive web-scraping framework covering the whole pipeline: parsing engine (lxml-based `Selector`/`Response`, Scrapy-like API), fetchers (plain HTTP → Playwright automation → stealth browser), sessions, proxy rotation, and a Scrapy-like Spider framework with AutoThrottle, pause/resume, robots.txt compliance, and ready templates (SitemapSpider, CrawlSpider, ShopifySpider...). Also AI-facing features: MCP server, an official Agent Skill, and one-line LLM-ready Markdown (`page.markdown()`, scripts/styles/prompt-injection content stripped).

### B2. Install verification (done in this environment)

```sh
uv venv research/scrapling-venv --python 3.12
uv pip install --python research/scrapling-venv/bin/python "scrapling[fetchers]"   # scrapling==0.4.15
research/scrapling-venv/bin/scrapling install     # downloads Chromium + headless shell + fingerprint deps (~/.cache ms-playwright)
```
Note: plain `pip install scrapling` includes only the parser engine — importing `scrapling.fetchers` raises ModuleNotFoundError until you install the `fetchers` extra and run `scrapling install`. All imports and all three example scripts below ran successfully.

### B3. Working example scripts (in `research/scrapling-examples/`)

1. **`01_basic_fetcher.py` — static page via `Fetcher`** (curl_cffi engine, TLS impersonation). Ran: status 200 on quotes.toscrape.com, extracted 10 quotes + authors + tags via `.css(".quote")` chaining, pagination link, response metadata. Key args: `impersonate='chrome'` (latest Chrome TLS fingerprint; also firefox/safari/edge/tor, versioned strings, random-from-list), `stealthy_headers` (default True; real browser headers + Google referer), `http3`, `retries=3`, SSRF-safe redirect handling (`follow_redirects="safe"` default).
2. **`02_dynamic_fetcher.py` — JS-rendered SPA via `DynamicFetcher`** (vanilla Playwright). Ran against the VitePress deepseek-harness docs page: got 200, title, 5 client-side-rendered sidebar links, h2 headings. Used `network_idle=True` (wait until no network connections ≥500 ms — important for SPAs), `disable_resources=True` (drop fonts/images/media for speed). Other modes: `real_chrome=True` (use installed Google Chrome — less detectable), `cdp_url=` (attach to remote/managed browser). Automation hooks: `page_action(page)` after navigation, `page_setup(page)` before navigation (routes/listeners), `wait_selector` + `wait_selector_state`, `capture_xhr=<regex>` collects matching background API responses into `response.captured_xhr`.
3. **`03_adaptive_match.py` — adaptive/auto-match relocation**. Two demos: (A) deterministic offline redesign — select `#p1` with `auto_save=True` on old HTML, verify selector breaks after DOM restructure, then same selector with `adaptive=True` relocates "Product 1"; (B) Wayback Machine snapshots of quotes.toscrape.com with `adaptive_domain` unifying archive.org/quotes.toscrape.com keys. Mechanics: `auto_save=True` stores the matched element's unique properties under a domain key (SQLite storage by default); later, if the selector misses, `adaptive=True` scores stored properties against all elements and returns the best match — similarity algorithms, no AI. Works with css, xpath, find_all, find_by_text, etc. Enable per-fetcher via `Fetcher.adaptive = True` / `configure(adaptive=True, adaptive_domain=...)` or per-request `selector_config={...}`.

### B4. Which fetcher for which situation (guidance for future subagents)

| Situation | Use | Notes |
|---|---|---|
| Static HTML, APIs, speed matters | `Fetcher` / `FetcherSession` | curl_cffi; TLS impersonation default latest Chrome; fastest (🐇×5) |
| JS-rendered page, light-moderate protection | `DynamicFetcher` / `DynamicSession` | Playwright Chromium/Chrome; full Page API automation |
| Cloudflare Turnstile/Interstitial, hard anti-bot | `StealthyFetcher` / `StealthySession` | auto-bypasses CF Turnstile; CDP/WebRTC leak fixes, canvas noise, headless-detection patches, timezone defenses |

Anti-bot notes:
- Prefer escalating: try `Fetcher` first; if blocked/fingerprinted, `DynamicFetcher`; if still blocked, `StealthyFetcher` (`solve_cloudflare=True` on StealthySession for CF challenges). Don't jump straight to browsers — they cost ~10× memory/time.
- Browser fetchers accept `headless=False` for stubborn sites (headful evades detection), `real_chrome=True`, `proxy`/`proxy_rotator` (`ProxyRotator` cyclic/custom strategies across all session types), `google_search=False` to drop the Google referer, DoH DNS-leak prevention, ad/domain blocking, `disable_resources` for speed (but disable it if resource-blocking itself looks botlike).
- Blocked-request detection + retry is built into spiders; AutoThrottle adapts delays per domain and backs off on blocks/rate-limits (respects `Retry-After`). Optional `robots_txt_obey`.

Session handling:
- One-off class methods (`Fetcher.get`, `StealthyFetcher.fetch`) open/close connection or browser per call. For multi-request crawls always use session classes: `FetcherSession` (context-manager, works sync AND async), `StealthySession`/`DynamicSession` keep ONE browser alive across requests; async variants `AsyncStealthySession(max_pages=N)` maintain a tab pool (`get_pool_stats()`), enabling concurrent fetches with `asyncio.gather`.
- Sessions carry cookies/state across requests; pass `cookies=` per request too.
- In Spiders, override `configure_sessions(manager)` and register named sessions (`manager.add("http", FetcherSession())`, `manager.add("stealth", AsyncStealthySession(...))`), then route per request with `response.follow(url, sid="stealth", callback=...)`; first added session is default, `lazy=True` defers browser startup until first use.

Other tips:
- `Response` = `Selector` + `.status/.reason/.cookies/.headers/.request_headers/.history/.body(bytes)/.meta/.captured_xhr`; selection: `.css()/.xpath()/.find_all()/.find_by_text()`, pseudo-elements like `::text`/`::attr(href)`, chained selectors, navigation (`parent`, `next_sibling`, `below_elements`), `find_similar()`, `markdown(main_content_only=True)` for RAG pipelines (needs `rag` extra).
- Subagents should run Scrapling inside the prepared venv: `/Users/srutinayak/self-evolving-agent/research/scrapling-venv/bin/python` (Python 3.12; system python is 3.14 — untested upstream there).

---

## Combined takeaways for our subagent architecture

1. **Composition-as-data**: both projects validate configuring capability sets declaratively (dsh: cordis.yml patches/profiles/isolate realms; Scrapling: session/fetcher choice per situation). Our subagent prompts should specify fetcher strategy + capability sets as data, not prose.
2. **Escalation ladders**: Scrapling's Fetcher→Dynamic→Stealthy mirrors dsh's provider-swap-at-the-seam idea: keep the interface constant, swap the implementation on failure.
3. **Self-extension channels**: dsh gives agents watched skill dirs + code/workflow seams; Scrapling ships its own Agent Skill + MCP server. When we build crawling subagents, attach a Scrapling usage skill (this report's §B4) and prefer `page.markdown()` for LLM consumption.
4. **Durable logging invariant**: adopt dsh's "model-visible means logged" rule for any agent whose context we mutate mid-run.
