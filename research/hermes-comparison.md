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

Results: see below (filled in from the runs).
