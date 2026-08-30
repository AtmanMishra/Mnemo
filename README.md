# Mnemo

A terminal-native agentic coding and harness assistant whose memory works like a brain. Small and local models can reach frontier-level performance through accumulated memory, experience, and hierarchical collaboration rather than raw model scale. Proven live: 3/3 task success WITH memory versus 0/3 WITHOUT, on a free model (ox-alpha-free via OpenCode).

## Quickstart

Requires Node >= 22.6 (native TypeScript stripping, no build step) and Rust (for the memory sidecar).

```bash
git clone https://github.com/AtmanMishra/self-evolving-agent
cd self-evolving-agent

cd memory-layer && cargo build --bin memsrv
cd ../agent && npm install
npm link  # or: node ./bin/mnemo.ts directly

mnemo auth        # interactive: pick provider, paste key, pick default model
mnemo "explain this repo"
```

With no provider configured, the first run launches the auth wizard automatically. Credentials live in `~/.mnemo/auth.json` (chmod 600), never in the repo.

## Commands

| Command | Purpose |
|---------|---------|
| `mnemo` | Interactive chat (TUI via pi InteractiveMode) |
| `mnemo "<prompt>"` | One-shot query |
| `mnemo auth [status\|logout <provider>]` | Manage credentials |
| `mnemo consolidate` | Distil recurring episodes into semantic lessons |
| `mnemo traces [session-id]` | Span trees from ~/.mnemo/logs; `--json` for raw output |
| `mnemo --list-models` | Show available models per provider |
| `mnemo --list-sessions` | List past sessions |

**Cockpit TUI:** `cd tui && cargo run --bin mnemo-cockpit` — single app with nav rail (Chat / Memory / Agents / Skills / Logs), driven by pi's RPC mode. Tab or alt+digit to switch panes; `?` shows keybindings; `/` opens command palette.

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

- **memory-layer/** (Rust) — Graph memory engine: nodes (facts/state/log/context), typed edges, steering, HNSW search. Exposed as memsrv JSON-RPC sidecar.
- **harness-engine/** (TypeScript, zero deps) — Dynamic tool-plugin system: createHarness() writes bundles that agents build for themselves at runtime.
- **agent/** (TypeScript on Node >=22.6) — The mnemo CLI; thin shim over pi with Mnemo's tools and extensions injected.
- **tui/** (Rust, ratatui) — mnemo-cockpit: nav rail UI driven by pi's RPC mode, showing chat, memory, agents, skills, and structured logs.

## Development

All four codebases must be green:

```bash
cd agent && npm test && npx tsc --noEmit
cd ../memory-layer && cargo test
cd ../tui && cargo test
cd ../harness-engine && npm test
```

Live task tracker: **plan.md** (7 areas with checkboxes). See **STATUS.md** for outcomes and verification. **HANDOFF.md** for picking up cold. **research/** for design docs and architecture.

## License

MIT
