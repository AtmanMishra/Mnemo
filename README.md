# Mnemo

A terminal-native agentic coding and harness assistant whose memory works like a brain. Small and local models can reach frontier-level performance through accumulated memory, experience, and hierarchical collaboration rather than raw model scale. Proven live: 3/3 task success WITH memory versus 0/3 WITHOUT, on a free model (ox-alpha-free via OpenCode).

## Quickstart

Requires Node >= 22.6 (native TypeScript stripping, no build step) and Rust (for the memory sidecar).

```bash
git clone https://github.com/AtmanMishra/self-evolving-agent
cd self-evolving-agent

cd memory-layer && cargo build --bin memsrv   # the Memory pane talks to this
cd ../agent && npm install                     # the agent the TUI drives

cd ../tui && cargo run --bin mnemo-agent
```

On first launch, `mnemo-agent` runs a colourful pixel-themed onboarding wizard inside the TUI: pick a provider, paste an API key, and pick a default model. Credentials are saved to `~/.mnemo/auth.json` (chmod 600), never in the repo. The navigation rail has six panes: Chat, Sessions, Memory, Agents, Skills, Logs. Use Tab/Shift-Tab or Alt+digit to switch; `?` shows keybindings; `/` opens a command palette.

## Commands

| Command | Purpose |
|---------|---------|
| `mnemo-agent` | Full TUI: Chat / Sessions / Memory / Agents / Skills / Logs (build: `cd tui && cargo run --bin mnemo-agent`) |
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
| `permissions.json` | Tool allow/ask/deny rules with glob patterns (enforced even without TTY) |
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
- **tui/** (Rust, ratatui) — mnemo-agent: full TUI with nav rail (Chat / Sessions / Memory / Agents / Skills / Logs), pixel design system, driven by pi's RPC mode.

## Development

All four codebases must be green (479 passing, 0 failing total):

```bash
cd agent && npm test && npx tsc --noEmit        # 195 passing, 0 failing
cd ../memory-layer && cargo test                # 44 passing, 0 failing
cd ../tui && cargo test                         # 204 passing, 0 failing
cd ../harness-engine && npm test                # 19 passing, 0 failing
```

Brand, design system and keybindings: **DESIGN.md**. Architecture with diagrams: **docs/**. Live task tracker: **plan.md** (8 areas with checkboxes). See **STATUS.md** for outcomes and verification. **HANDOFF.md** for picking up cold. **research/** for design docs and architecture.

## License

MIT
