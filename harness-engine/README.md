# harness-engine

A dynamic harness engine for a self-evolving coding agent. It lets an agent
**create its own tools at runtime**: an LLM generates JS tool source, the engine
validates it, writes it to disk as a *skill bundle*, registers it in a scoped
registry, and hands back a `Disposable`. Watched skills directories pick up new
or rewritten bundles automatically.

Inspired by DeepSeek Harness (`dsh`) composition patterns (per-scope registry
layers, effect-based registration, watched skill roots with write-triggered
invalidation) and by pi's loader-tool / lazy-activation pattern.

Zero runtime dependencies. Requires Node >= 22.18 (runs `.ts` via native type
stripping — no build step).

## Architecture

```
                       createHarness()  <-- THE SELF-EXTENSION SEAM
  LLM agent  ──spec──▶  {name, description,
                         tools:[{name, schema, source}]}
                              │
                              ▼
                    ┌──────────────────┐    reject imports of fs /
                    │   safety gate    │    child_process unless
                    │   (safety.ts)    │    allowlisted; syntax
                    └────────┬─────────┘    compile check; shape check
                             │ ok
                             ▼
                    ┌──────────────────┐   <root>/<bundle>/
                    │   writeBundle    │     manifest.json
                    │   (bundle.ts)    │     tools/<tool>.mjs
                    └────────┬─────────┘
                             │ import() with cache-busting nonce
                             ▼
   ┌─────────────────────────────────────────────────────┐
   │                 ToolRegistry                        │
   │                                                     │
   │   scope layers:      session  ◀── highest wins       │
   │   (nearest shadows)  project                        │
   │                      global                         │
   │                                                     │
   │   register(bundle) ──▶ Disposable                   │
   │   dispose() unregisters + deactivates tools         │
   └───────▲───────────────────────────▲──────────────────┘
           │                           │
  ┌────────┴─────────┐        ┌────────┴──────────┐
  │   SkillsWatcher  │        │ getLoaderTool()   │
  │  fs.watch + 500ms│        │ "load_tools"      │
  │  debounce per    │        │ activate by name, │
  │  bundle dir;     │        │ return schemas    │
  │  rewrite =       │        │ (pi lazy pattern) │
  │  invalidate      │        └───────────────────┘
  └──────────────────┘
   watches ./skills (project) and ~/.agent/skills (global)
```

## Bundle format

```
skills/
  my-bundle/
    manifest.json          # {name, version, description, tools:["tools/foo.mjs"]}
    tools/
      foo.mjs              # default-exports {schema, execute(params)}
```

`foo.mjs`:

```js
const schema = { type: "object", properties: { city: { type: "string" } } };
export default {
  name: "forecast",
  description: "fake forecast",
  schema,
  async execute(params) {
    return `sunny in ${params.city}`;
  },
};
```

## API

```ts
import { ToolRegistry } from "./src/registry.ts";
import { createHarness } from "./src/create-harness.ts";
import { SkillsWatcher } from "./src/watcher.ts";
import { getLoaderTool } from "./src/loader-tool.ts";

const registry = new ToolRegistry();

// 1. Self-extension: agent-generated tool source becomes a live tool.
const { bundleId, disposable } = await createHarness({
  registry,
  root: "./skills",
  spec: {
    name: "weather-kit",
    description: "demo",
    tools: [{
      name: "forecast",
      schema: { type: "object", properties: { city: { type: "string" } } },
      // execute-body form; or pass a full ES module containing export default
      source: "return `sunny in ${params.city}`;",
    }],
  },
  scope: "session",            // global | project | session
});

// 2. Scoped lookup, nearest layer wins.
await registry.resolve("forecast")!.tool.execute({ city: "Oslo" });

// 3. Effect-based lifecycle.
await disposable.dispose();    // unregisters, deactivates its tools
registry.resolve("forecast");  // => undefined

// 4. Watched dirs: ./skills (project) and ~/.agent/skills (global).
const watcher = new SkillsWatcher(registry, [
  { path: "./skills", scope: "project" },
  { path: "~/.agent/skills", scope: "global" },
]);
await watcher.start();         // new/changed bundles appear in ~500ms–1s
// watcher.errors holds invalidation errors (broken rewrites drop the bundle)

// 5. Loader tool (pi lazy-activation pattern).
const loadTools = getLoaderTool(registry);
const out = JSON.parse(await loadTools.execute({ names: ["forecast"] }));
// out.activated[0].schema  -> JSON schema for the next model request

// 6. Scope override: session tool named X shadows project/global X.
registry.register(sessionBundle, "session");
```

## CLI

```sh
node bin/harness-engine.js list                          # visible tools
node bin/harness-engine.js create spec.json --skills ./skills --scope project
node bin/harness-engine.js watch                         # ./skills + ~/.agent/skills
```

`spec.json` is a `HarnessSpec`: `{ name, description, version?, tools: [{name,
description?, schema, source}] }`.

## Tests

```sh
npm install && npm test     # node:test, no LLM calls, no network
npm run typecheck           # tsc --noEmit
```

50 tests cover: bundle create/dispose roundtrip, scope override precedence
(and loud shadow warnings), watched-dir pickup latency (<1s), invalidation on
file rewrite and on deletion, symlink-escape containment, loader-tool
activation, and all safety-gate rejection paths.

## Security notes — read before loading agent-written code

**The gate runs on EVERY load path.** `loadBundle()` (src/bundle.ts) is the
single entry point every caller — `createHarness`, the watcher, the CLI —
goes through, and it gates the on-disk source of every tool file BEFORE it
is imported. A bundle that appears on disk (or is rewritten) is gated just
as hard as one created through the API.

The safety gate (`src/safety.ts`) does:

- scan static `import`, dynamic `import()`, and `require()` specifiers —
  including backtick template literals (`import(\`fs\`)`) via a paren/string-
  aware scanner;
- reject ANY `import()`/`require()` whose specifier is NOT a literal string
  (variable, concatenation, `.join(...)`) — unverifiable means rejected;
- reject `fs`, `fs/promises`, `child_process` AND the net-class / host-info
  modules (`http`, `https`, `net`, `tls`, `dns`, `os`, `process`, plus
  `node:` forms) unless passed via the `allowModules` option;
- reject direct `process` / `globalThis.process` access even with no import;
- reject absolute imports; relative imports are resolved against the file,
  confined to the bundle dir (lexically AND after realpath), and the target
  file's source is scanned recursively (depth cap 3, cycle-guarded) — a
  bundle-shipped helper doing the real work is caught;
- enforce manifest shape: non-empty string tool refs, no `..`/absolute/symlink-
  escaping paths (refs must stay inside the bundle dir);
- enforce a JSON-schema object with `type: "object"` per tool and an `execute`
  function;
- syntax-check source via an `AsyncFunction` compile (imports stripped,
  `export default` transformed to `return`) before anything is imported.

Fail-closed posture: anything the scanner cannot verify (missing helper file,
  unreadable target, non-literal request) is a rejection, not a pass. The
  watcher records the error and skips the bundle without crashing.

The registry also makes scope shadowing loud: registering a project/session
bundle whose tool names hide broader-scope tools records a `ShadowEvent`
(`registry.shadowEvents`) and warns — nearest-shadows is the design, but it
is never silent.

It does **NOT** sandbox anything:

- Registered tools execute **inside this Node process with full privileges**
  (a739fbd8 — documented, accepted risk). The gate filters what gets LOADED;
  it cannot constrain what a loaded tool does at runtime.
- Escapes the gate cannot see: `fetch()` (global, no import), prototype
  pollution, infinite loops, and obfuscation inside `eval`/`Function` bodies.
- ESM caches cannot be surgically evicted; unregistering drops the strong
  reference and every reload uses a unique URL nonce so stale module instances
  are never reused (they become garbage-collectable). Memory of dead modules is
  reclaimed by GC, not freed deterministically.

For real isolation run bundles in `node --permission` workers or containers.
Treat every registered bundle as trusted code from the moment it loads.

## Future attachment plans (not implemented here)

**pi agent bridging.** Each registered bundle maps naturally onto pi's
extension API. A thin bridge extension would subscribe to registry changes and
call `pi.registerTool({ name, description, parameters: tool.schema, execute })`
for every visible tool, and `pi.setActiveTools(registry.getActive())` whenever
the loader tool activates something. Because pi supports `registerTool()` after
startup and detects additive changes mid-session, newly created harnesses become
model-callable without `/reload`. The engine's `Disposable` mirrors pi's effect
unregistration semantics.

**Rust memory layer.** Every bundle created through `createHarness()` will be
recorded as a `Harness` node in the Rust memory graph (bundle id, manifest,
tool schemas, creation provenance, scope), giving the agent durable recall of
capabilities it has built across sessions. The engine exposes the hooks
(`CreateHarnessResult.bundleId/dir/tools`); memory-layer calls will be added
once the two packages agree on the node schema. No memory calls exist yet.

## Design notes / deviations from the brief

- Tool files use `.mjs` so bundles are always ES modules regardless of any
  nearby `package.json`.
- `source` accepts two forms: a full ES module (contains `export default`,
  written verbatim) or an execute body (wrapped into a generated default
  export). This keeps LLM output small for simple tools.
- Registry keys are bundle manifest names within a scope; tool lookup scans the
  nearest scope's bundles by tool name, so one bundle can provide many tools.
- Watcher debounce defaults to 500ms per top-level bundle directory (dsh-style
  write-triggered invalidation); broken rewrites unregister rather than keep a
  stale version.
