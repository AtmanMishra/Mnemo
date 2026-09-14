# Mnemo's command surface, next to Hermes'

*A research review, not a spec. Scope: how commands, tools, skills and extensions
are registered, discovered and invoked — in Hermes (the reference) and in Mnemo
(the thing being extended).*

**Out of scope, deliberately:** gateways, messaging platforms, channel adapters,
bots, delivery targets, web dashboards, desktop apps, IDE/ACP servers. Hermes
has all of those; none of them are what this review is about. Anything below
that touches a platform is mentioned only to be excluded.

Sources: Hermes' own docs and skill references (`hermes_cli/commands.py`,
`toolsets.py`, the slash-command and CLI references); pi's vendored docs
(`agent/node_modules/@earendil-works/pi-coding-agent/docs/` — `rpc.md`,
`extensions.md`, `prompt-templates.md`); and the Mnemo tree itself
(`tui-go/internal/command/`, `tui-go/app/update.go`, `agent/extensions/`,
`agent/bin/mnemo.ts`).

---

## 1. How Hermes does it

### 1.1 One registry, and everything derives from it

`hermes_cli/commands.py` holds `COMMAND_REGISTRY`: every slash command is one
`CommandDef`. `hermes --help`'s command list, in-session `/help`, the
autocomplete dropdown, and every platform's command menu are generated from
that one structure. Adding a command is three steps — a registry entry, a
handler in `cli.py`'s `process_command()`, and optionally a platform handler —
and nothing else needs to learn about it, because nothing else keeps its own
list.

That is the whole idea, and it is worth stating as the design rule it is:
**a command cannot exist in one surface and not another, because there is only
one surface.** The help text cannot drift from the implementation, because the
help text is the implementation's own table.

### 1.2 The CLI is a second, coarser registry

`hermes <subcommand>` covers what a slash command cannot: setup, model and
provider management, config, tools and toolsets, skills (browse/search/install/
inspect/publish/tap), MCP servers, sessions, cron, profiles, credentials,
checkpoints, logs, completion. Subcommands supplied by plugins appear only once
that plugin is installed.

### 1.3 Tools are data; *exposure* is policy

A tool is one file in `tools/`, with a `registry.register(name, toolset,
schema, handler, check_fn, requires_env)` call at the bottom. Files are
auto-discovered by import; that only makes the tool *exist*. What makes it
*visible to the model* is its name appearing in a toolset in `toolsets.py`.
Toolsets are the unit of control: `/tools` and `hermes tools enable|disable`
switch them per platform, `check_fn` hides a tool whose requirements are not
met, `requires_env` documents what it needs. Changing tools takes effect on
`/reset` — never mid-conversation, because the tool list is part of the prompt
and changing it invalidates the prompt cache.

### 1.4 Skills, and everything around them

A skill is a `SKILL.md` with frontmatter. Around that: a hub (`hermes skills
browse|search|install|inspect|publish`), bundles (one `/<name>` alias that
loads several skills at once), a curator that reports staleness and can archive
or pin, `/learn` to distil a skill out of a directory or a conversation, and
taps that turn a git repo into a skill source.

### 1.5 Plugins are the third-party boundary

`~/.hermes/plugins/` is a drop-in directory: a plugin can add tools,
subcommands, and skills without touching the core. This is what keeps the core
small and lets the ecosystem grow sideways instead of by PR.

### 1.6 The loop, and the invariants that constrain all of the above

`run_conversation()` is the shape you would guess: build the system prompt, loop
(up to `agent.max_turns`, default 90) calling the model and dispatching tool
calls until the model returns text, with context compression triggering near the
limit (`compression.threshold` 0.50, `target_ratio` 0.20). Around it: approvals
(smart/manual/off), delegation with a depth cap, cron, checkpoints and rollback,
a pluggable memory provider.

Three invariants decide most design questions, and two of them are about the
command surface specifically:

- **Never break prompt caching** — the tool list and system prompt are part of
  the cached prefix, which is why tool changes wait for a new session.
- **Message role alternation** — the conversation must alternate; a command that
  injects a turn has to respect that.
- Paths come from `get_hermes_home()`, settings from `config.yaml`, secrets from
  `.env` — never mixed.

---

## 2. How Mnemo does it today

### 2.1 Three registries, and no shared source of truth

| Surface | Where it lives | What it contains |
|---|---|---|
| The TUI's list | `tui-go/internal/command/command.go` | 16 built-ins, plus skills, plugin skills and harness bundles discovered from disk |
| The agent's commands | `agent/extensions/hooks-inline.ts`, `schedules-inline.ts` | `/hook`, `/schedule`, `/trigger`, `/now`, registered with `pi.registerCommand()` |
| The CLI | `agent/bin/mnemo.ts` | `auth status\|logout`, `traces`, `consolidate`, `schedule …`, plus pi's own subcommands passed through |

The TUI's `Load()` builds one list nearest-first (built-ins, then skills from
`.claude`/`.pi`/`.agents` roots walked up to the git root, then plugin skills
from `~/.claude/plugins/cache`, then harness manifests), dedupes by name, and
`Match()` filters it by **name prefix, then substring** — deliberately not
fuzzy, with the reasoning written down. The palette and the prompt's slash menu
both read that list, so within the TUI they cannot disagree.

### 2.2 Tools

`agent/src/tools/index.ts` exports `allTools` (14: bash, read/write/edit, glob,
ipy, skills ×3, subagent, harness, web ×2, image). `sea-tools-inline.ts`
registers them all onto pi, plus 3 memory tools, plus MCP tools discovered
before `main()` runs, plus whatever a harness bundle adds at runtime — and wires
the same list into the kernel's `tools.<name>()` dispatcher. There is no gating:
every tool is offered every session. The one piece of conditional logic is a
name-conflict dance — `web_search`/`web_fetch` are claimed at `session_start`
only if a globally-installed pi package has not taken those names, because two
tools with one name make pi refuse the whole extension.

### 2.3 What pi already offers, and what the TUI asks for

This is the part that changes the review. pi's RPC surface is ~25 commands.
Mnemo's client sends three of them (`tui-go/internal/pi/pi.go`: `prompt`,
`steer`, `abort`).

| pi RPC command | What it does | Used by Mnemo |
|---|---|---|
| `prompt` / `steer` / `abort` | send, steer, interrupt | yes |
| `get_commands` | **every extension command, prompt template and skill, with name, description, source, location, path** | no |
| `compact` (`+ customInstructions`), `set_auto_compaction` | compact the context, for real | no |
| `set_session_name` | name the session | no |
| `get_state` | model, thinking level, streaming/compacting, steering mode, session file/name, message count, pending count | no |
| `set_thinking_level`, `cycle_thinking_level`, `get_available_thinking_levels` | reasoning effort | no |
| `set_model`, `cycle_model`, `get_available_models` | model switching | no (the TUI writes the auth store directly) |
| session entries, usage/cost | pre-compaction history, tokens, `contextUsage`, cost | no |

And two pi features that exist today, undocumented in this repo:

- **Prompt templates** — `~/.pi/agent/prompts/*.md` and `.pi/prompts/*.md`
  become `/name` in the editor, with `description` and `argument-hint`
  frontmatter. pi expands them before the prompt is sent.
- **Skill commands** — `/skill:name`, expanded by pi the same way.

---

## 3. The review

### 3.1 The finding that matters most

**The TUI rejects commands the agent implements.** Type `/hook list` into Mnemo
today and the notice line says:

```
no command called /hook · ^k lists them all
```

Reproduced with `--dump --keys "/,h,o,o,k,space,l,i,s,t,enter"`. The agent has
had a `/hook` command since AREA 9; pi would execute it (its RPC docs: extension
commands execute immediately, even mid-stream, and skill/prompt commands are
expanded before sending). The TUI never gets that far, because
`update.go`'s `slash()` treats its own list as a gate: `Find()` misses, and the
line is refused rather than routed.

That single line of policy produces a bad user experience and hides three
different features: the agent's own commands, prompt templates, and pi's skill
commands. It is also the reason the palette cannot be a complete answer to
"what can this thing do" — the thing that knows the most is not the thing that
is asked.

A second finding is about how this surface is *assembled*, and it is the reason
the first probe behind this review never got an answer: see §6.5. A conflict
between two extensions the user installed in `~/.pi/agent/extensions/` aborts
the agent at startup, and the interface never says so.

### 3.2 Comparison

| Capability | Hermes | Mnemo today | The gap |
|---|---|---|---|
| Command registry | one (`COMMAND_REGISTRY`), all surfaces derive | three (TUI list, pi commands, CLI) | the TUI cannot see the agent's commands |
| Custom user commands | skills; bundles; `/learn` | skills only, invoked as prompts | prompt templates exist in pi, unused and undocumented here |
| Argument hints / completion | subcommand-aware CLI, template `argument-hint` | names only, prefix-then-substring | typing `/model ` completes nothing |
| Tool exposure policy | toolsets + `check_fn` + `/tools enable\|disable`, applied at `/reset` | all tools, always | no per-session or per-project tool gating |
| Tool availability | hidden when requirements unmet | offered, then explains itself (web_search without a key) | cosmetic, but it costs a turn |
| Skills lifecycle | hub, bundles, curator, taps | discovery + agent-authored `create_skill` | install/update/staleness unbuilt |
| Third-party extension | drop-in `~/.hermes/plugins/` | in-tree `InlineExtension` (repo edit) + agent-authored harness bundles | a stranger cannot add a command without a PR |
| Session control | `/title /status /usage /compact /branch /resume /diff /rollback` | sessions overlay; `u` undoes a turn; queue/steer | `/compact`, `/name`, `/status`, `/thinking` are one RPC call away |
| Runtime toggles | `/verbose /yolo /skin /reasoning /busy` | env vars at launch | nothing toggleable in-session except model/provider |
| Docs from the registry | generated from it | `^h` help from the keymap (good) | the slash list has no generated doc surface |

### 3.3 So what is actually missing?

Being honest about size, because the gap list reads worse than it is:

- **Big:** one place that knows every command and can be asked (3.1's root
  cause), and a tool exposure policy.
- **Medium:** argument completion, session/context commands, third-party
  extension loading.
- **Small:** surfacing prompt templates (they work already — pi expands them),
  `/status` from `get_state`, `/name` from `set_session_name`.
- **Not real:** the "missing `/compact`" entry in the tui-go gap list. pi has
  `compact` over RPC; the entry assumed a client-side fake, which was the right
  call to refuse and the wrong reason to stop.

---

## 4. Proposals

Ordered by value per unit of risk. None of them is a new subsystem; P1–P5 are
changes to two files each.

**P1 — Make the slash handler a router, not a gate.** *(small, do first)*
Unknown name → send it to the agent as a prompt, exactly as pi expects, instead
of refusing it. Typing `/hook list` then works. The TUI keeps its built-ins
(they open overlays — a pi command cannot do that), and stops pretending to
know the whole world. Risk: a typo now reaches the model as prose. Mitigate by
only routing names that look like commands pi owns (from P2) and keeping the
refusal for everything else.

**P2 — Ask pi what its commands are.** *(medium)*
At session start, send `get_commands` and merge the answer into the palette,
the slash menu and `^h`, tagged by `source` (extension / prompt / skill) and
`location` (project / user). This is Hermes' one-registry rule implemented the
only way a client can: by asking the authority rather than keeping a copy.
Refresh on extension-relevant events (and when `/reload` lands).

**P3 — Document and surface prompt templates.** *(small)*
`~/.pi/agent/prompts/*.md` gives users custom slash commands with
`description` and `argument-hint` today. Mnemo should mention them in the
README, show them in the palette (P2 does this for free), and — since the
project already writes skills — treat "a prompt template for a repeatable
instruction, a skill for a repeatable procedure" as the documented split.

**P4 — Complete arguments, not just names.** *(medium)*
The data exists: providers and models in `internal/auth`, hook ids in the hooks
registry, schedule ids in `schedules.json`, template hints from `argument-hint`.
`/model <tab>` and `/login <tab>` should complete. Keep the deliberate
prefix-then-substring rule for names; argument completion is a different
problem and can be exact.

**P5 — Session and context commands pi already supports.** *(medium)*
`/compact` (with no custom instructions; a client-side fake stays forbidden),
`/name <title>` (`set_session_name`), `/status` (`get_state`: model, thinking
level, tokens, context usage, message count, session file), `/thinking <level>`
(`set_thinking_level`). This closes three entries on the tui-go gap list with no
protocol work and no lies about what happened.

**P6 — A tool exposure policy, without the platform matrix.** *(medium)*
`~/.mnemo/tools.json` listing enabled toolsets/names, `/tools` to read it back,
`/tools enable|disable <name>` to write it — taking effect **next session**,
for the same prompt-caching reason Hermes waits for `/reset`, and saying so in
the notice. Default: everything on, exactly as today. The win is a project that
can turn off `web_search`/`create_harness` for a repo where they are noise.

**P7 — Let a stranger extend it.** *(medium)*
pi already auto-discovers extensions from `~/.pi/agent/extensions/` and
`.pi/extensions/` with hot reload. Mnemo's four extensions are in-tree
`InlineExtension`s, which is right for the shipped surface and wrong for
anyone else's. Documenting the on-disk path — and verifying our extensions do
not collide with what a user puts there — costs a doc and a test.

**P8 — Skill lifecycle, locally.** *(optional)*
`mnemo skills list|check`: what is installed, where from, when it was last
touched (a curator-style staleness report). A hub, taps and a publish flow are
a product, not a pre-alpha feature.

---

## 5. What not to build

- **Anything channel-shaped.** No messaging adapters, no bots, no delivery
  targets, no gateway. This review is about the agent's own surface; Hermes can
  afford a platform matrix because it is a platform product, and Mnemo is a
  terminal agent whose whole design rule is one surface.
- **A second registry.** Every proposal above feeds the list the palette and
  the slash menu already read. The moment there are two lists again, 3.1 comes
  back wearing a different hat.
- **A client-side `/compact`.** pi implements it; a client fake would delete
  messages the model is still standing on.
- **A web dashboard, a desktop app, an IDE server.** Out of scope by request
  and by shape.
- **Fuzzy command matching.** Already decided against, for a good reason
  (a list that reorders under your fingers). Argument completion is not a
  licence to revisit it.

---

## 6. Verified against the live agent, and what is still open

The questions above were checked against a real agent rather than left as
assumptions — one `get_commands` over RPC, no model call:

```
$ node agent/bin/mnemo.ts --mode rpc --no-builtin-tools -ne   # then: {"type":"get_commands"}
success: true | count: 14
by source: {"extension": 5, "prompt": 3, "skill": 6}
names: llama, hook, schedule, trigger, now, implement-and-review, implement,
       scout-and-plan, skill:analyze-sessions, skill:pdf-reader, skill:web-debug,
       skill:youtube-transcript, skill:caveman, skill:find-skills
```

1. **Mnemo's own commands do appear.** `hook`, `schedule`, `trigger`, `now` are
   in the list as `extension` commands, so P1 and P2 are viable exactly as
   designed — the TUI can ask for the list it is currently blind to.
2. **Prompt templates are already first-class commands** (`implementation`,
   `implement-and-review`, `scout-and-plan` on this machine, `source: "prompt"`).
   P3 is smaller than it looked: the feature is not just present, it is in use.
3. **The two skill sets differ.** pi's startup line said `skills: 11 loaded`,
   while `get_commands` returned 6 `skill:` commands. Whatever the reason, the
   palette must reconcile the answer from the agent with what the TUI found on
   disk (or ask the agent and drop its own scan for agent-side skills) rather
   than assuming they are the same list.
4. **The documented reply shape is not the installed one.** `rpc.md` prints
   `location` and `path` flat; pi 0.84 nests them in a `sourceInfo` object
   (`scope`, `path`). Implementation reads both — flat first, `sourceInfo` as
   the fallback — because the point of these rows is saying where a command
   came from, and which shape carries it is pi's business, not the client's.
   Worth reporting upstream.
5. **Assembling this surface can fail in a way nobody can see.** The first
   probe — without `-ne` — never answered, because two extensions the *user*
   installed under `~/.pi/agent/extensions/` register the same tool name:

   ```
   Error: Failed to load extension ".../subagent/index.ts":
     Tool "subagent" conflicts with ".../interactive-subagents/.../subagents/index.ts"
   Hint: Start without extensions using "pi -ne".
   ```

   The agent exits at startup. Mnemo spawns without `-ne` and does not capture
   the child's stderr, so under the TUI's alternate screen that text lands on
   the terminal unmanaged and the interface is left saying something generic.
   Two things follow: the failure needs to be Mnemo's to report (last stderr
   lines, in the transcript), and whether Mnemo should spawn hermetically is a
   real decision — Mnemo's own extensions survive `-ne` because they are inline
   factories, so `-ne` would buy isolation from user extensions at the cost of
   not loading them.

Still open:

- Does prompt-template **expansion** happen on the RPC `prompt` path, or only
  in interactive mode? `rpc.md` says expansion happens before queueing;
  confirm with one live send before P1 starts routing unknown names.
- Should Mnemo's built-ins move into pi as extension commands? No for the ones
  that open overlays (a pi command cannot drive the TUI), yes for anything
  purely agent-side. Write the split down once: *client affordance vs agent
  capability*.

---

## Appendix — where each surface lives

| Concern | File |
|---|---|
| TUI command list, discovery roots, matching | `tui-go/internal/command/command.go` |
| Slash parsing, routing, built-in handlers | `tui-go/app/update.go` (`slash`, `runSlash`) |
| TUI → pi client (three commands) | `tui-go/internal/pi/pi.go` |
| Tool inventory | `agent/src/tools/index.ts` |
| Tool registration, kernel dispatcher, web-tool conflict rule | `agent/extensions/sea-tools-inline.ts` |
| Agent commands registered with pi | `agent/extensions/hooks-inline.ts`, `agent/extensions/schedules-inline.ts` |
| CLI subcommands | `agent/bin/mnemo.ts` |
| Hooks command surface | `agent/src/hooks/commands.ts` |
| Schedule CLI surface | `agent/src/schedule/cli.ts` |
| pi's RPC contract (vendored) | `agent/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md` |
| pi's prompt templates (the unused feature) | `.../docs/prompt-templates.md` |
| pi's extension discovery (the third-party path) | `.../docs/extensions.md` |
