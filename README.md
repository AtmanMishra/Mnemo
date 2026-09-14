# Mnemo

A terminal-native agentic coding and harness assistant whose memory works like a brain. Small and local models can reach frontier-level performance through accumulated memory, experience, and hierarchical collaboration rather than raw model scale. Proven live: 3/3 task success WITH memory versus 0/3 WITHOUT, on a free model (ox-alpha-free via OpenCode).

## Quickstart

**Pre-alpha.** Grab the `mnemo` binary for your platform from
[Releases](https://github.com/AtmanMishra/self-evolving-agent/releases) —
linux/darwin/windows, amd64/arm64 — then build the two pieces it drives. Node
>= 22.18 is required (the first version that runs `.ts` files with no flag —
"no build step" is only true from there); Rust is
needed only for the memory sidecar, and Go only if you would rather build the
interface than download it.

```bash
git clone https://github.com/AtmanMishra/self-evolving-agent
cd self-evolving-agent

./scripts/install.sh              # macOS / Linux
.\scripts\install.ps1             # Windows (PowerShell)

# or do it by hand:
cd memory-layer && cargo build --bin memsrv   # the Memory pane talks to this
cd ../agent && npm install                     # the agent the TUI drives
cd ../tui-go && go build -o mnemo ./cmd/mnemo  # or drop the release binary here
```

The installers check your toolchain before touching anything, say what they are
doing, and take `--dry-run` (`-DryRun` on Windows) to say it without doing it.

`mnemo --version` says which build you are running. Bugs and rough edges belong
in [the issue tracker](https://github.com/AtmanMishra/self-evolving-agent/issues)
— the known gaps are filed there rather than described as future work.

On first launch, `mnemo` runs a colourful pixel-themed onboarding wizard inside the TUI: pick a provider, paste an API key, and pick a default model. Credentials are saved to `~/.mnemo/auth.json` (chmod 600), never in the repo. That wizard lives in the Go TUI itself (tui-go/). One unified surface — the transcript IS the application; everything else (palette, sessions, memory, logs, explorer) floats as an overlay dismissed with esc.

> The old Rust/ratatui TUI was archived on branch `archive/tui-rust` and is no longer part of the main system. It was fully superseded by tui-go/.

## Commands

| Command | Purpose |
|---------|---------|
| `mnemo` | the TUI — one surface, transcript-first (build: `cd tui-go && go build -o mnemo ./cmd/mnemo`) |
| `mnemo "<prompt>"` | One-shot query; how sub-agents run |
| `mnemo auth [status\|logout <provider>]` | Credential management (status checks provider/key; logout removes a provider) |
| `mnemo consolidate` | Distil recurring episodes into semantic lessons |
| `mnemo traces [session-id]` | Span trees from ~/.mnemo/logs; `--json` for raw output |
| `mnemo --list-models` | Show available models per provider |
| `mnemo --list-sessions` | List past sessions |

Inside a running session, use `/login` and `/model` to change provider or model.

## Configuration

Files under `~/.mnemo/`:

| File | Purpose |
|------|---------|
| `auth.json` | Provider credentials (chmod 600); never committed |
| `permissions.json` | Tool allow/deny rules with glob patterns (enforced everywhere, with or without a TTY). The `ask` tier is asked in the interface: the TUI spawns the agent with `MNEMO_APPROVAL_MODE=interactive` and answers pi's dialog. A run with no UI at all fails open (automation keeps working) — except a delegated sub-agent child, which fails closed |
| `mcp.json` | MCP servers as registered tools (named `mcp__<server>__<tool>`) |
| `logs/<date>.jsonl` | Structured trace spans; secrets redacted before write |

Environment variables:

- `MNEMO_APPROVAL_MODE=interactive` — prompt before mutating tools
- `MNEMO_PLAN_MODE=1` — read-only phase
- `MNEMO_LOG_LEVEL` — debug, info, warn, error, or off
- `BRAVE_API_KEY` or `TAVILY_API_KEY` — optional; enables web_search tool

## What's in here

- **memory-layer/** (Rust) — Graph memory engine: nodes (facts/state/log/context), typed edges, steering, HNSW search. Binaries: memcli (REPL), memsrv (JSON-RPC sidecar), memeval (retrieval benchmark), mempolicy (learned steering evaluation).
- **harness-engine/** (TypeScript, zero deps) — Dynamic tool-plugin system: createHarness() writes bundles that agents build for themselves at runtime.
- **agent/** (TypeScript on Node >=22.6) — The mnemo CLI; thin shim over pi with Mnemo's tools and extensions injected.
- **tui-go/** (Go, Bubble Tea v2) — the terminal interface: one surface, transcript-first, overlays for palette/sessions/memory/logs/explorer, hooks + schedules digests.

## Development

All four codebases must be green:

```bash
cd agent && npm test && npx tsc --noEmit
cd ../memory-layer && cargo test
cd ../tui-go && go test ./... && go vet ./...
cd ../harness-engine && npm test
```

Start with **`docs/MNEMO.md`** — what Mnemo is and how to run it — and go to **`docs/MNEMO-INTERNALS.md`** when you are changing it: memory model, kernel, protocols, extension points. **`DESIGN.md`** owns how it looks (palette, glyphs, mascot, keys). **`AGENTS.md`** is the contract for agents working in this repo. **`plan.md`** tracks the work, **`STATUS.md`** records outcomes with evidence, and **`research/`** holds the current design papers. Superseded architecture docs, reports and diagrams are in **`docs/archive/`**.

## License

MIT
