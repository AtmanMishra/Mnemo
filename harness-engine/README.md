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
                             │ boundary child by default (see
                             │ "Execution boundary" below)
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
node bin/harness-engine.js run ./skills/kit greet --params '{"who":"you"}'
node bin/harness-engine.js watch                         # ./skills + ~/.agent/skills
```

`spec.json` is a `HarnessSpec`: `{ name, description, version?, tools: [{name,
description?, schema, source}] }`.

`list`, `run` and `watch` put bundle code behind the execution boundary by
default; `--in-process` is the explicit downgrade, and `--timeout <ms>` sets the
per-call wall clock. `run` prints the tool's return value, or — on failure — the
whole report: how the process ended, why the boundary stopped it, and everything
the bundle printed.

## Execution boundary (issue #7)

**The problem.** A bundle is third-party code: `create_harness` accepts a
model-authored spec by design, and bundle source is therefore
attacker-influenceable through prompt injection. The safety gate
(`src/safety.ts`) is *lexical* — it filters what gets LOADED. It cannot
constrain what a loaded tool does at runtime, and it never could: `fetch()` is a
global with no import to scan, `eval` can hide anything, and a loop can hang the
host. Before this change a registered tool ran **in the agent's own process,
with the agent's environment (including its API keys) and its filesystem
reach**.

**What the boundary is.** `src/boundary.ts` + `src/child-runner.ts`. Bundle code
runs in a child process, and the host never evaluates it:

| | host | boundary child |
|---|---|---|
| reads manifest, gates on-disk source | yes | re-gates before import (closes the TOCTOU window) |
| imports the tool module | **never** (child mode) | yes, after the gate |
| builds `execute()` | a proxy holding name/description/schema | — |
| environment | the agent's env | explicit allowlist; credential- and injection-shaped names refused even if allowlisted |
| working directory | the agent's cwd | the bundle directory (realpath'd) |
| wall clock | a timer per call | killed at the limit: SIGTERM → SIGKILL on POSIX, `taskkill /T` → `taskkill /T /F` on Windows |
| stdout/stderr | captured, byte-capped, reported with the failure | whatever the bundle prints |
| failure | `execute()` throws a report | writes a result frame, exits non-zero |

The result frame travels as a **file in a scratch dir**, not on stdout: stdout
is the bundle's channel, and a bundle that can print could print a fake frame.
Its path is never in argv or the child's environment (the request arrives on
stdin), so bundle code cannot forge its verdict. The cache-busting nonce still
exists — in child mode every call is a fresh process, so module state cannot
leak between calls at all.

**What it does NOT do — read this before reading "isolated" anywhere else.**

- It is **not a sandbox and not isolation.** The child is the same user, with
  the same filesystem rights and the same network reach. A bundle can still
  `fetch()`, still read `~/.ssh/id_rsa` **if** it gets past the gate to a
  filesystem module, and still write anywhere the user can. The cwd jail is a
  default, not a wall.
- **The timeout bounds wall clock, not resources.** Memory, CPU and disk are
  unbounded; a bundle can allocate until the OS says no.
- **The gate's allowlist is the caller's decision.** `allowModules` was already
  the documented escape hatch; a bundle that is allowed `node:fs` can do
  everything that module can do, from the child.
- **Grandchildren that detach are beyond the tree kill.** `taskkill /T` and a
  POSIX process-group signal reach what the OS still tracks as the tree.
- **On Windows, a bundle directory stays locked while a child has it as cwd** —
  the boundary steps out of the jail on exit, but the OS can be a beat behind,
  so deleting a bundle dir immediately after a run may need a retry.

What it *does* buy: a crash, a `process.exit`, a hang or a fork-bomb-in-a-tool
can no longer take the agent with it, and the agent's API keys are not in the
child's environment.

**Design decision — why a child process.** The honest portable option, and the
reasoning is short: a `worker_thread` shares the parent's environment, so it
cannot hide the API keys; a container or VM is real isolation but is not
portable to a laptop and would be the first runtime dependency this package has
ever had; `node --permission` is promising but is still experimental, and a
permission model that silently changes between Node minors is worse than a
boundary you can explain. A child process is the only option that is portable
across Windows/macOS/Linux with zero dependencies, can be killed **as a tree**,
and can be given a **different environment**. `BoundaryOptions.nodeArgs` exists
so a caller who wants `--permission` on top can have it.

**Where the default lives.** `createHarness()` (the self-extension seam, the
path the model's own code takes), `SkillsWatcher`, and the CLI all default to
`execution: "child"`. `loadBundle()` itself defaults to `"in-process"` so
metadata paths and gate tests do not pay for a spawn — and every `LoadedBundle`
carries `execution`, so a caller can never be unsure which one it holds. The
downgrade is explicit (`execution: "in-process"`, CLI `--in-process`) and it is
reported in the result text, because a silent downgrade is how this issue
happened in the first place.

**Tests that assert the properties** (`test/boundary.test.ts`, 12 tests): env
scrubbing (a secret in the host's env is absent from the child, attested by the
child), the cwd jail (module top-level side effects land in the bundle dir), that
the host never imports the bundle (the module reports a pid that is not the
host's), timeout + tree kill (the pid is gone afterwards), escalation
(SIGTERM → SIGKILL / `taskkill /T` → `/T /F`, with an injected kill system so no
real tree is signalled), bounded output (a 20k-line flood, verdict intact),
honest failure (thrown message + stderr + stdout + exit code in the error),
a bundle that calls `exit(3)` taking only itself down while the host keeps
running bundles, gate ordering (the gate refuses *before* any spawn), and the
defaults above.

## Tests

```sh
npm install && npm test     # node:test, no LLM calls, no network
npm run typecheck           # tsc --noEmit
```

The suite (`npm test`, 42 tests) covers: bundle create/dispose roundtrip, scope
override precedence (and loud shadow warnings), watched-dir pickup latency,
invalidation on file rewrite and on deletion, symlink-escape containment,
loader-tool activation, every safety-gate rejection path, and the
execution-boundary properties listed above.

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

It did **NOT** sandbox anything — and the runtime half of that is now addressed
by the **Execution boundary** section above:

- Registered tools no longer execute **inside this Node process with full
  privileges** by default (a739fbd8 — the documented, accepted risk). The gate
  still filters what gets LOADED and still cannot constrain what a loaded tool
  does at runtime; the boundary changes WHERE that runtime is. `in-process`
  remains available and explicit, and then this paragraph applies verbatim:
  the tool runs in the agent's process, with the agent's environment.
- Escapes the gate cannot see: `fetch()` (global, no import), prototype
  pollution, infinite loops, and obfuscation inside `eval`/`Function` bodies.
  The boundary contains the *consequences* of the last two (a hang is killed, a
  crash dies alone); it does nothing about network reach or prototype pollution
  in the child — and a bundle that polls prototypes does it in a process that
  then exits.
- ESM caches cannot be surgically evicted; unregistering drops the strong
  reference and every reload uses a unique URL nonce so stale module instances
  are never reused (they become garbage-collectable). Memory of dead modules is
  reclaimed by GC, not freed deterministically. In child mode this is moot:
  every call is a fresh process.

For real isolation run bundles in `node --permission` workers or containers —
`BoundaryOptions.nodeArgs` is the seam for the former. Treat every bundle as
code you are executing: the boundary bounds the blast radius and hides the
agent's secrets. It does not make the code safe.

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
