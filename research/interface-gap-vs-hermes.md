# Mnemo's interface measured against Hermes Agent

A gap list, not a wish list. Everything below is drawn from two things that can
be re-run by anyone:

    # Mnemo's command surface
    grep -oE '\{Name: "[a-z]+"' tui-go/internal/command/command.go

    # Hermes' surface
    hermes --help

The first prints 21 builtins; the second lists about 80 subcommands. Counting is
not the point — the point is which *kinds* of thing a person can do, and the
categories below are where the difference actually lives.

**What this is not.** It compares surfaces, not internals. A Hermes subcommand
and a Mnemo command are not the same unit of work, and several of Hermes' names
have no business in a TUI. Two things I have not yet done, so nobody reads more
into this than is here: I have not read Hermes' source, and I have not driven
its TUI. Its side of each row comes from its documented command list and from
being run through its interface all day; Mnemo's side comes from the code in
this repository.

---

## Where Mnemo already holds its own

Stated first, because a gap list that only lists gaps is a bad map.

| Area | Mnemo | Hermes |
| --- | --- | --- |
| **Consent before action** | five-answer dialog (once / always-project / always-everywhere / deny / other), patterns that generalise by subcommand and never by program, deny rules that outrank a mode called "full privileges" | `approvals`, `security`, `--yolo`, `--safe-mode` |
| **Extensibility** | skills, plugins, MCP servers, hooks, harness bundles | `skills`, `plugins`, `mcp`, `hooks`, `bundles` |
| **Diagnostics** | `/logs` — spans *and* structured log lines, labelled; `--dump` for a frame | `logs`, `debug`, `dump` |
| **Scheduling** | `/schedules` over a daemon with a pid lease, cost triggers | `cron` |
| **Sessions** | `/sessions` tree, `/fork` picker, `/compact` | `sessions`, `--resume`, `--continue` |
| **Memory** | `/memory` with areas, consolidation, supersede-not-delete | `memory`, `memory-graph`, `learning`, `journey` |

Mnemo's consent model is genuinely ahead of what most agents ship, and its
diagnostics are honest when something fails. That is worth knowing before
rebuilding anything.

---

## The gaps, in the order I would close them

### 1. Nothing can tell you whether Mnemo is healthy — **highest value**

    Mnemo:   (nothing)
    Hermes:  hermes doctor, hermes verify, hermes status

A real install failed verification and the person had no way to ask "what is
wrong?" short of reading the transcript. There is no `mnemo doctor` that
answers: is the agent runtime present, is the memory sidecar reachable, is a
provider configured, does the model resolve, can Mnemo write its own logs, is
the binary on PATH. That check is the difference between a bug report and a
fixable one, and it is the cheapest to build because every fact it needs is
already known to the code.

### 2. First run — partly done today, still incomplete

    Mnemo:   numbered onboarding + /login + /model      (ad3a086)
    Hermes:  a setup flow, --tui/--cli, profiles, onboarding to a working turn

Today's fix tells a person what to do; it does not yet *check the outcome*.
After a login the next screen should confirm the key works — one request, one
answer — rather than leaving the first real turn to discover it. And there is no
"skip this, I know what I am doing" path for someone re-installing.

### 3. No fallback when the model fails

    Mnemo:   (nothing in the TUI; the scheduler has a fallback model, chat does not)
    Hermes:  fallback — providers tried when the primary fails

The most common real failure in a long session is a provider that starts
erroring at minute forty. Today the turn dies and that is that. A fallback list
is small and it is the difference between losing a session and losing a sentence.

### 4. Context and cost are invisible until you open a log

    Mnemo:   tokens appear in the /logs span tree
    Hermes:  prompt-size, insights, monitoring, /cost-style visibility

There is no live answer to "how full is the context?" or "what has this cost?"
while working. The data is already collected (the spans carry tokens) — it is
simply not surfaced where the decision is made. `/compact` exists and is a
blind decision today.

### 5. No way back: checkpoints, restore, self-update

    Mnemo:   (nothing)
    Hermes:  checkpoints, backup, update, uninstall

Mnemo edits files and runs commands in a real repository with no checkpoint
before a turn and no `mnemo update`. `--dry-run`-style reversibility is the
feature people discover they need exactly once, at the worst moment.

### 6. Configuration is scattered and only half-discoverable

    Mnemo:   ~/.mnemo/{auth,theme,limits,trust,permissions,schedules}.json, read by six packages
    Hermes:  config, skin, profiles, and a documented precedence

There is no `/config` that shows every file, its path, its keys and their
current values. Today you learn the shape of the configuration by reading the
source. (The theme picker and the limits file are good precedents — the pattern
exists, it just is not general.)

### 7. Smaller, named, not urgent

- **Reasoning level** — Hermes has one per session; Mnemo has thinking blocks but
  no control over how much the model thinks. (`set_thinking_level` exists in pi.)
- **Model catalogue** — `/model` lists what the key can run, then forgets; there
  is no "this model failed last time" memory.
- **Profiles / multiple identities** — one `~/.mnemo`, one configuration.
- **Sharing a session** — no export, no hand-off; the transcript is copyable and
  that is all.

---

## What I would do first, and why

**`mnemo doctor`.** One command, no model call, exits non-zero when something is
wrong, prints the fix per line. It is the smallest piece on this list, it is the
one the user's failed install needed most, and it makes every later bug report
actionable — including the next five rows of this file. Second is the post-login
check (one request, one answer), because it closes the loop today's onboarding
opened but does not finish.

Each of those is a main-agent job with a test and a frame, in the same shape as
`ad3a086`: evidence first, the exact command in the commit message, and the
regression named rather than hidden.
