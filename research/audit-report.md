# SEA-AGENT AUDIT — becoming a single-CLI competitor
Date: audit of repo @ 05e0a77..f88f42a. Method: graft codebase graph + runtime probes
+ competitor feature survey (Claude Code, Codex CLI, Gemini CLI, OpenCode, prime-agent).
Visual direction: tui-design skill (Persistent Multi-Panel paradigm) + minimalist-ui restraint rules.

## A. SINGLE-CLI BLOCKERS (P0 — why `sea` doesn't feel like `claude` yet)

A1. **No credential store / auto-loading.** bin/sea.ts never loads .env; keys must be
    exported manually every shell. Claude/Codex/Gemini store auth once (keychain/config)
    and just work.
    FIX: `sea` shim loads ~/.sea/auth.json (+ .env fallback); add `sea /login` wizard that
    prompts provider choice + key, writes it. Effort: ~1 day.

A2. **No first-run experience.** With no keys, `sea --help` prints PI's help branded
    "pi - AI coding assistant" — wrong brand, zero guidance.
    FIX: detect no-auth → run onboarding wizard (pick provider, paste key, pick default
    model, write config); rebrand help header to SEA.

A3. **Not installable.** No npm publish, no `files` field, TS-run-direct requires
    node>=22.6 undocumented. Competitors: `npm i -g @x/cli` then one command.
    FIX: add files/engines fields + postinstall check; publish scoped package OR provide
    `npm link` quickstart in README. Effort: half day.

A4. **No persisted defaults.** SEA_MODEL/SEA_PROVIDER required per shell; pi has a
    settings manager we don't surface (saved default provider/model exists inside pi —
    needs first-run to set it).
    FIX: part of A1 wizard.

## B. TUI / VISUAL GAPS (P1 — the cockpit you asked for)

B1. **No unified navigation shell.** Chat/Memory/Agents/Skills/Logs live in 4 separate
    programs. Target: Persistent Multi-Panel layout (lazygit pattern):
    left nav rail (Chat/Memory/Agents/Skills/Logs), main pane, bottom input+status.
    Per tui-design skill: consistent 1-cell gutters, focus ring on active pane,
    h/j/k/l + number-key pane switching, ? overlay, q with confirm.
    BLOCKER: pi InteractiveMode is a closed alt-screen app; panes must be OUR ratatui
    layer hosting pi via its RPC mode (documented, stable) OR as an embedded child.
    This is the main engineering lift (~1-2 weeks).

B2. **Subagent tree page missing everywhere** (competitors: Claude Code /tasks, Codex
    agents panel). We have the DATA (journal episodes + DerivedFrom edges) but no UI.
    Build into cockpit Agents pane: tree from journal, status/spend per node,
    Enter = inspect transcript, k = kill.

B3. **Trace/log viewer missing.** Journal ops exist; no UI surfaces them as spans
    (tool -> inputs/outputs/duration). Cockpit Logs pane.

B4. **Visual refinement pass** (minimalist-ui applied to terminal): drop emoji glyphs,
    use consistent Nerd Font icon set w/ ASCII fallbacks; typographic hierarchy via
    weight+color not decoration; restrained palette (PICO-8 accents only on state
    changes: green=ok red=fail yellow=pending); kill double-borders except pane frames.

## C. AGENT CAPABILITY GAPS (P2 vs competitors)

C1. MCP support: none. Every competitor speaks MCP. Fix: bridge MCP servers as tools
    (pi extensions can host clients) or adopt an MCP client lib. ~2-3 days.
C2. Web search/fetch tools: absent. Claude Code has WebSearch/WebFetch. ~1 day via
    Brave/Tavily key + fetch tool.
C3. Plan mode (read-only planning phase before edits): absent. Claude Code flagship
    feature. Medium effort: system-prompt phase + tool allowlist switch.
C4. Permission RULE ENGINE: OpenCode has allow/ask/deny per tool+pattern; we have
    interactive y/n only (pi's --approve is project-trust, NOT tool permissions —
    verified in args.js). Extend approval-gate with ~/.sea/permissions.json.
C5. Checkpoints/undo of file edits: competitors snapshot; we rely on git. Low priority.
C6. Image/screenshot input: pi supports image content; our tools don't surface attach.
C7. @file mentions + fuzzy file autocomplete in editor: pi editor may support; verify.

## D. WHAT ALREADY WORKS (no action)
- Single binary entry (bin/sea.ts) forwarding full pi flag surface incl. --thinking
  (effort), --resume/--continue/--fork/--session-id, --export, --theme, --list-models
- AGENTS.md auto-loaded by pi resource-loader (verified: AGENTS.override.md,
  AGENTS.md, CLAUDE.md candidates) — our graft/skill instructions reach the model
- Memory loop, steering, subagent spawning, harness self-build, skills, eval 3/3

## E. RECOMMENDED BUILD ORDER
1. A1+A2+A4: auth store + /login wizard + branding (makes `sea` self-contained)
2. B1 cockpit skeleton: nav rail + Chat pane via RPC mode
3. B2+B3: Agents tree + Logs panes (data already exists)
4. A3 packaging + C1 MCP
5. B4 visual refinement pass + C3 plan mode + C4 rule engine
