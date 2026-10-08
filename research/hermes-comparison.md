# Mnemo vs Hermes Agent — memory and self-improvement

*2026-10-08. Hermes Agent's design as documented at
hermes-agent.nousresearch.com (features/memory, skills, curator, honcho,
sessions) and in its repository (`cli-config.yaml.example`,
`agent/background_review.py`, `tools/session_search_tool.py`), read the same
day. Measurements: `app/eval/` on `opencode-go/deepseek-v4.1-flash`.*

## The designs, side by side

| | Hermes Agent | Mnemo |
|---|---|---|
| **Store** | two Markdown files: `MEMORY.md` (2,200 chars), `USER.md` (1,375), §-separated entries | a journal-backed graph (Rust `memsrv`): project and user profiles (key → value, a new value supersedes and keeps history), session records, pitfalls with fixes, skills, provenance |
| **Scope** | per Hermes profile — one memory for every project | per project (git remote, so every clone shares it) plus one user profile; one repository's memory never reaches another's prompt |
| **In the prompt** | both files, frozen at session start | the profiles in the system prompt (stable, cache-friendly); per message, what search finds (pitfalls with fixes, earlier sessions, skills) and, first message, the last session's open work |
| **A write mid-session** | on disk at once; in the prompt next session | in the prompt from the next run of the same session |
| **Who writes** | the model, through a `memory` tool, when it thinks to — plus a background review every 10 user turns (and a flush on exit) | a reflection call after every run that did something (model-independent: it does not rely on the model remembering to save), plus `memory_remember` |
| **What is learned** | free-text entries the model chooses | typed: facts (only what the user said or a tool showed — a guess is dropped), the session record (goal, outcome, done, decisions, open), failure → fix pairs, skills |
| **Full memory** | an add over the cap errors; the model must consolidate | per-key supersede; the newest 40 facts per profile reach the prompt |
| **Failures** | — | each distinct failure is one marker, counted across sessions; a fix found later is attached; **the guard** stops a command that failed before, once, with the known fix |
| **Past sessions** | `session_search`: SQLite FTS5 over every message (BM25), no LLM | `session_search`: SQLite FTS5 over Mnemo's *and Claude Code's* sessions, scoped to the project, redacted |
| **Skills: create** | `skill_manage`; nudge every 15 tool iterations; background skill review ("most sessions produce at least one skill update") | `create_skill` (project `.agents/skills` or personal); the reflection proposes one when a procedure was shown or asked for, saved when asked or seen twice, with approval |
| **Skills: improve** | the background review patches skills ("lessons, not logs") | the reflection sees the skills a run followed and patches one only on evidence (a step failed, the user corrected it); approval; old text kept |
| **Skills: retire** | curator: stale after 14 days, archived after 30, every 7 days | `mnemo memory curate`: stale 30 / archive 90 days by recorded last use; personal skills moved, project skills reported only |
| **Safety** | entries scanned for injection, exfiltration, invisible Unicode; optional write approval | the same refusals on every write path (tool, MCP, reflection of another agent's transcript); credentials redacted before anything reaches memory, a log, or the reflection model |
| **Other agents** | memory providers (Honcho, Mem0 …) plug *into* Hermes | Mnemo's memory plugs *into* other agents: Claude Code (hooks + transcript ingest), Codex/Cursor/opencode (MCP) — a frontier model's sessions teach the memory a cheap model uses |
| **Verification** | — | verify-before-done: a run that changed code and checked nothing goes back once |
| **Published evaluation** | none found for the memory or learning loop | `app/eval/`: scenario suite, learning-curve series, Hermes-style arm on the same loop and model |

## Where each is weak

**Hermes** (from its docs and issues): models under ~30B say "I'll remember"
without calling the tool; the caps force project details out (issue #5563);
memory is shared across projects; the background review "can burn a
meaningful share of total tokens"; a mid-session write is invisible until the
next session.

**Mnemo**: more machinery (a Rust sidecar, a graph); the profile can fill
with long facts the code already shows; recall ranking is lexical (no local
embedder yet); no published comparison until this one.

## The head-to-head

The Hermes arm (`app/eval/hermes.ts`) reproduces the documented built-in
memory on Mnemo's own pi loop, with the same model, tools and skills, so the
only difference between arms is the memory. Session search, Honcho and the
curator are not part of the arm. Its background review runs after every
session (Hermes reviews every 10 user turns and flushes on exit; these eval
sessions are one prompt long) — the generous reading.

All runs: `opencode-go/deepseek-v4.1-flash`, one machine, 2026-10-08. Raw
reports and transcripts summaries are in `app/eval/results/` under the named
directories. Small samples: read the differences as direction, not effect size.

### Learning-curve series (one repo, 7 rules per task, 3 repeats)

`series-2026-10-08T08-46-34-618Z`. Six tasks in one repo; each is scored on
seven points, among them rules stated once and never visible in the code.

| | no memory | Hermes-style | Mnemo |
|---|---|---|---|
| score, all tasks | 87% | 100% | 100% |
| score, tasks 4–6 | 86% | 100% | 100% |
| cost per series | $0.024 | $0.020 | $0.019 |

Both memories hold everything at one repo, and both cost less than none (fewer
rediscovery steps).

### Two repos, conflicting rules (2 repeats)

`multi-2026-10-08T09-26-27-729Z`. Sessions alternate between `till` and
`ledger`, whose rules contradict each other (reply format, build step, history).

| | no memory | Hermes-style | Mnemo |
|---|---|---|---|
| all sessions | 82% | 100% | 99% |
| after both rule sets were stated | 78% | 100% | 99% |
| cost per run | $0.041 | $0.027 | $0.031 |

Mnemo's one miss is a history rule in one ledger session. Hermes was **not**
hurt by two repos: everything fits its 2,200 characters at this size. Whether
its shared, capped memory degrades at many repos — the reason Mnemo scopes per
project — is a hypothesis this run does not test.

### Scenario suite (7 scenarios, 2 repeats)

`2026-10-08T08-20-57-241Z`, re-scored after two check fixes (negation-aware
package-manager check; fixture errors matched only at line start).

- **projects-stay-apart**: the other project's command is not suggested —
  Mnemo 2/2, Hermes 0/2, no memory 2/2. Hermes' memory is global, so a
  command learned in project A was offered in project B both times.
- **picks-up-the-thread**: "where were we" resumes the open work — Mnemo 2/2,
  Hermes 1/2. Mnemo keeps open items per session; Hermes only if the
  review happened to write them down.
- The other scenarios (convention, pitfall, correction, skill from a
  procedure, checks its work) tie after the fixes.

The no-memory arm is not fully memoryless: `create_skill` exists in all arms,
so the model can write itself a skill file and read it later. Both
picks-up-the-thread baseline runs read outside their sandbox (integrity 0/2)
looking for the prior session.

### Knowledge: do the skills and facts evolve? (3 repeats)

`2026-10-08T09-23-49-927Z`. procedure-evolves releases a package three times;
before the second release a policy file adds a signing step the first
release's skill did not have. Checks read what each arm stored (skills,
Hermes' MEMORY.md/USER.md, Mnemo's profile and pitfall fixes).

| check | Mnemo | Hermes-style | no memory |
|---|---|---|---|
| second release went out despite the new rule | 3/3 | 3/3 | 3/3 |
| third release follows the corrected procedure | 3/3 | 3/3 | 3/3 |
| what was learned includes the signing step | 3/3 | 3/3 | 3/3 |
| the release procedure is a skill | 3/3 | 3/3 | 3/3 |
| skill-from-procedure: later release followed it | 3/3 | 3/3 | 3/3 |
| correction-sticks: later session follows the correction | 3/3 | 3/3 | 2/2 ¹ |

¹ one baseline run broke integrity (read pi's own docs outside the sandbox) and
is not scored.

All three tie at the ceiling. In each arm, Mnemo's and Hermes' reviews both
patched the skill when signing appeared (`Updated skill relay-release: …`). The
baseline also passes because the policy file is in the repo and the model
reads it each time. **These tasks do not separate the arms**: a
discriminating version needs a rule that is stated once and is *not* left in
the repo. That is the series' design, and there the baseline drops to 78–87%.

### What this says

- At one or two repos, a well-run Hermes-style memory matches Mnemo on
  accuracy, and both clearly beat no memory (+13 to +18 points) at lower cost.
- Mnemo's measured edge is structural: project scoping (2/2 vs 0/2) and
  session continuity (2/2 vs 1/2). Those are the failure modes you get with
  more than one project, or with work that spans sessions.
- The arm is the *generous* reading of Hermes (reviews every session, a model
  that calls the memory tool). The weaknesses its own docs report (small
  models skip the tool, the caps evict project detail) are not exercised.
- Not measured yet: many repos (capacity), a long horizon (staleness and the
  curator), and a public benchmark.
