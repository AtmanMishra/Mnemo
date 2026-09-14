# Agent Terminal Interface — Design v0.1
Goal: a small-model coding agent reaching frontier-level performance through
memory, experience, and hierarchical collaboration. Terminal-first UX like prime-agent.

## 1. Layered architecture

    ┌─────────────────────────────────────────────┐
    │  TUI  (Rust + ratatui)                      │  the product users see
    │  chat / agent-tree / memory / activity      │
    └──────────────────┬──────────────────────────┘
                       │ JSON-RPC over stdio/socket (pi RPC mode)
    ┌──────────────────┴──────────────────────────┐
    │  AGENT RUNTIME (pi, TypeScript)             │
    │  - multi-provider LLM clients               │
    │  - agent loop, steering/followUp queues     │
    │  - session JSONL trees (= subagent tree)    │
    │  - extensions = our plugin surface          │
    ├─────────────────────────────────────────────┤
    │  HARNESS ENGINE (TS)   MEMORY LAYER (Rust)  │
    │  self-built tools/skills   graph+vectors    │
    └─────────────────────────────────────────────┘

Why this split: pi already solved providers, loops, compaction, session trees.
Our Rust memory layer stays a fast sidecar. The TUI is pure presentation +
command palette, so it never re-implements agent semantics.

## 2. Multi-provider LLM connections
- pi natively supports many providers (Anthropic/OpenAI/OpenRouter/local via
  custom providers). TUI gets: provider/model picker (Ctrl+P), per-session model,
- Effort/thinking-level selector maps to pi thinkingLevel.
- Local small models (DeepSeek-class, Ollama/vLLM endpoints) are first-class:
  our thesis is that memory compensates for model size. Provider profile presets
  stored in settings.

## 3. Hierarchical subagents (the core feature)
Model: TREE of agents where every node is a pi session branch (parentId links
already exist in pi's JSONL trees -> tree is native, not bolted on).

Spawn protocol (parent P spawns child C on task T):
1. P calls memory_search(T description, k) on the Rust sidecar.
2. P composes a CONTEXT BRIEF: top-k nodes' state summaries + explicit facts
   P knows are relevant. NOT the transcript. This implements "only context the
   parent thinks is useful".
3. C starts with: its own system prompt + brief + tool access. Everything C
   sees is logged into C's episode node ("model-visible means logged").
4. C works; C may spawn C1..Cn the same way (depth limit + budget guard).
5. On completion C writes back: outcome node + facts learned + updated state
   in the SHARED memory layer. Parent reads results from memory, not from
   streaming tokens -- decoupled, resumable, crash-safe.

Shared-vs-scoped memory rule:
- facts/outcomes/harnesses: global graph (all agents see them eventually)
- live working state: scoped to each agent's own episode node
- parent->child context: push-based brief at spawn (our original contract)

Budget guards per subtree: max depth (default 3), max concurrent children,
token budget propagated down (child inherits remaining budget).

## 4. Skills, plugins, MCP
- Skill discovery EXACTLY as pi docs: ~/.pi/agent/skills/, ~/.agents/skills/,
  project .pi/skills/ + .agents/skills/ (after trust), package.json pi.skills,
  settings skills array, --skill flag. SKILL.md frontmatter standard-compliant.
- Harness-engine integration: createHarness() writes bundles INTO those skill
  locations; watcher picks them up; loader-tool lazy activation keeps prompts cheap.
  Self-extension loop: agent builds skill -> it becomes a Harness node in memory
  -> searchable next session ("I built k8s-debug last week" recall).
- MCP: bridge external MCP servers as pi extensions (register each MCP tool as
  an AgentTool). Config in settings; servers listed in TUI settings pane.

## 5. Standard feature checklist
| Feature | Source | Notes |
|---|---|---|
| compact | pi compaction entries | /compact command + auto threshold |
| effort | pi thinkingLevel | low/med/high selector |
| settings | pi settings + ours | TUI settings pane, ~/.config/agent/ |
| session resume | pi sessions | /resume list of past sessions |
| import/export | add: export session JSONL+memory slice to bundle zip; import restores both |
| reload | pi extension hot reload | /reload |
| system prompt | pi AgentState.systemPrompt | /system view+edit |
| logs | pi event stream + journal ops | /logs pane, filterable |
| context check | token counting from pi usage events | /context meter in status bar |
| triggers & loops | rlm-heartbeat-style: cron-ish triggers that wake agent with a prompt | /loop set <interval> <prompt>, persisted |
| git integration | common expectation | status/diff/commit tools built-in |

## 6. TUI design (ratatui)
Panes (resizable, hideable):
- CHAT (main): streaming assistant output, markdown-rendered, input line at bottom
  (multi-line editor, history, slash-command autocomplete)
- AGENT TREE (right-top): live tree of spawned agents: id, task label, status
  (running/done/failed), model, token spend; Enter -> inspect child transcript;
  k kill child; f follow (stream child output into chat pane)
- MEMORY (right-bottom): mini-memtui -- nodes matching current conversation,
  search box, steer indicators
- ACTIVITY (bottom strip): tool calls streaming by (name, target, duration)
Status bar: model@provider, effort, context meter (x% used), cost estimate,
session name, git branch.
Command palette: Ctrl+K fuzzy over all slash commands + settings toggles.
Keybindings: vi-style navigation inside panes; Ctrl+C interrupt generation;
Esc back/cancel.

TUI <-> runtime: TUI launches `agent --rpc` (pi RPC mode child process) OR
attaches to an existing one (attach/resume). All state changes arrive as RPC
events; TUI never parses transcripts directly except on attach/import.

## 7. Build phases
A. Runtime skeleton on pi: boot, chat over RPC, one tool (bash), model switch.
   (overlaps with existing pi-runtime-builder work in agent/)
B. Memory wiring: extension exposing memory_search/memory_write/memory_steer
   to the running agent; every turn logged into an episode node automatically.
C. Subagent tree: spawn protocol + budget guards + tree data exposed via RPC.
D. Skills+harness bridge: discovery at pi locations + createHarness loop + MCP bridge.
E. Full TUI: all panes above against the real RPC stream.
F. Triggers/loops + import/export + polish.

## 8. Open questions for the user
Q1. TUI language: Rust/ratatui confirmed? (Alternative: use pi's own TS TUI
    components and customize -- faster but less control.)
Q2. Subagent defaults: max depth 3 ok? Parallel children limit?
Q3. Context-brief size: cap in tokens (e.g., 2k per child brief)?
Q4. Which local runtimes first: Ollama, llama.cpp server, vLLM?
Q5. MCP priority vs skills-first?

## 9. Decisions (user-confirmed)
- D1. TUI framework: ratatui (ratatui.rs) CONFIRMED for the main agent TUI.
- D2. Design language: PIXEL design system -- chunky borders, box-drawing/braille
  texture fills, retro palette (PICO-8-inspired), stepped/quantized spacing,
  Nerd Font glyphs. Pixel TYPEFACES depend on the user's terminal font
  (terminals cannot load fonts programmatically): we ship a recommended preset
  (e.g., Silkscreen / Press Start 2P / Pixelify Sans as terminal font) and the
  UI degrades gracefully to any monospace font. All "pixel-ness" that does not
  need font support is implemented in-drawing: double-line borders, dithered
  progress meters (braille cells), 2-cell block cursors.
- D3. Subagent defaults (my call): max depth 3; max 4 concurrent children per
  node; context brief cap 2000 tokens per spawn; token budget split evenly
  among children unless parent overrides.
- D4. Providers: CLOUD FIRST. OpenRouter as primary aggregator (one key ->
  hundreds of models incl. free tier), then direct Anthropic/OpenAI keys.
  Local runtimes (Ollama/vLLM/llama.cpp) supported but later priority --
  not everyone can run models locally.
- D5. Extensions priority: SKILLS-FIRST (harness-engine bridge before MCP),
  because self-built skills are the core self-evolution loop. MCP second.
- D6. memtui: keep as lightweight memory dashboard; gets standard keybinds
  (j/k, g/G, ?, y copy, n/N search nav) but NOT the pixel system -- pixel
  identity belongs to the main agent TUI.
