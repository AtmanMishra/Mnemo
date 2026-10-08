# Self-evolution audit — the agent and the memory sidecar

*2026-10-08. Read against `app/` (the Bun prototype on pi 1.1) and `memory-layer/`
(`memsrv`), and **measured**: four experiments drive the real sidecar the way the
app's extensions do (scripts reproduced in §8). Findings cite file:line. Earlier
reviews are `research/agentic-capability-review.md` (M1–M17) and
`research/memory-runtime-design.md` (J0–J11); where a finding repeats one of
those, it says so instead of re-deriving it.*

---

## Status (updated 2026-10-08, same day)

Phase A and most of Phase B are built; see the commits after `c173297`.

| Finding | State |
|---|---|
| F1 multi-process journal | **fixed** — every request syncs under the journal lock (`memory-layer/tests/integrity_rpc.rs`) |
| F2 stale search cache | **fixed** — any write clears it |
| F3 recall in the system prompt | **fixed** — profiles in a stable system prompt, recall as a message (`test/memory-loop.test.ts` asserts byte-identical prefixes) |
| F4 markers linked as feeders | **fixed** — only knowledge and the profiles are linked |
| F5 duplicate pain markers | **fixed** — one marker per normalized failure signature, counted |
| F6 junk gap nodes | **fixed** for tool errors (`gap: false`); recall ignores `gap:` nodes |
| F7 token-bag lessons | **mitigated** — shutdown consolidation is off and `lesson:` nodes are not recalled until lessons are written as sentences (Phase D) |
| F8 steering does not affect ranking | open (Phase D: trust-weighted ranking) |
| F9 log rendering | **fixed** |
| F10 recall across projects | **fixed** — `PartOf` + scoped search; other projects' profiles filtered |
| F11 empty episodes | **fixed** — episode record (goal, outcome, done, decisions, open) + "last session" |
| F12 project = path | **fixed** — git remote / repo root identity |
| F13 profile budget and provenance | partial — 40-fact budget, `/forget`; per-fact provenance open |
| F14 usefulness never voted | **fixed** — distinctive-reuse credit |
| F15 weak embedder | open (Phase D) |
| F16 ungated reflection | **fixed** — worth-it gate, `source` tag, guesses not written |
| F17 skills only by volunteering | **partial** — candidates from reflection, saved on request or on recurrence through approval; usage logged; patch/retire loop open |
| F18 orphan sub-agent episodes | **fixed** — child episode `PartOf` parent |
| F19 consolidation only on shutdown | open (Phase D sleep runtime) |
| F20 memory_steer without correction | open |
| F21 fixes not stored | **fixed** — fix attached to the failure's marker, recalled as "pitfall … fix …" |
| F25 secrets in memory | **fixed** — redaction before every write |

Measurement: `app/eval/` runs six multi-session scenarios with and without
memory against a real model (default `opencode-go/deepseek-v4.1-flash`).

## 0. Verdict

Mnemo today **remembers** — it does not yet **evolve**. A self-evolving agent
closes five loops; this is where each one stands:

| Loop | What it means | State |
|---|---|---|
| **1. Capture** | turn each session into durable knowledge | **Partial.** Reflection writes key/value facts onto a project and a user profile after every run. Episodes themselves are empty shells (F11); what was *done*, *decided* and *fixed* is not kept (F21). |
| **2. Recall** | put the right knowledge in front of the model | **Partial, with defects.** Profiles are always injected; search recall is global across projects (F10), returns duplicated noise (F5, F6), serves stale results (F2) and breaks the prompt cache every turn (F3). |
| **3. Credit assignment** | outcomes change what is trusted | **Mostly missing.** Steering adjusts edge weights that do not affect ranking (F8); profiles are never blamed or credited (F4); the usefulness vote is never cast (F14); the strongest signals Mnemo already receives — the user's "no, do X instead", test results, commits — are not used (§3). |
| **4. Abstraction** | many episodes become one lesson / one procedure | **Not useful yet.** Lessons are token bags ("lesson: bash found") with no content and no links (F7). Skills are created only if the model volunteers (F17). |
| **5. Maintenance** | merge, correct, forget, measure | **Missing.** No dedupe, no contradiction sweep, no decay, no forgetting in the app, no metric for "did memory make the next session better" (F20, F23). |

Two defects are **data-integrity** problems and come before any feature: two
Mnemo processes on one journal corrupt each other (F1), and the search cache
hides new memories (F2).

What is right and should be kept: the journal-as-truth model (replay-exact,
supersede-never-delete), one-current-value-per-key, the planner/apply split in
Rust, profile injection (robust even with the weak embedder), the extension
host pattern in `app/`, and testing the whole loop on pi's faux model.

---

## 1. How it works today

```
user message
  └─ pi before_agent_start ── memory ext ──┬─ state(project profile), state(user profile)
                                           ├─ search(prompt) → recall(): filter, top 4
                                           ├─ episode created on first prompt ("task: <prompt>")
                                           ├─ link(hit → episode, SuppliesContext)   ← every recalled node
                                           └─ systemPrompt += directive + profiles + recall
  └─ model ↔ tools (policy gate first)
        tool_execution_end ── log "<tool>: ok|error" on the episode
                           └─ on error: steer(episode, "<tool> failed: <text>")
                                 → pain node (Salience), blame feeders by word overlap,
                                   or a gap node if nothing overlapped
  └─ agent_end ── good(episode) if no errors (reinforce feeders)
              └─ reflection: one model call over a digest → JSON facts → learn() on profiles
  └─ session_shutdown ── consolidate() (lexical lessons)
```

---

## 2. Findings

Severity: **P0** corrupts or hides memory · **P1** makes the loop wrong or
useless · **P2** quality, cost, missed value.

### P0 — fix before anything else

**F1. Two processes on one journal diverge and cross-wire nodes.**
Each `memsrv` replays the journal once at start and then serves from its own
in-memory store; the `fd_lock` (`persist.rs:55`) only stops interleaved *lines*.
Measured (exp2): process B did not see A's write; both then allocated node id 1
from their own counters, so the journal holds two `CreateNode{id:1}`; on replay
the second is rejected and its facts land on the other node. Two terminal
windows, or a crash-restart beside a live session, is enough. *Fix:* one writer
per journal — a per-home `memsrv` daemon on a local socket that every Mnemo
process connects to — or, minimally, under the lock: re-read the journal tail,
apply it, then allocate ids and append.

**F2. The search cache hides new memories.**
Invalidation drops cached entries whose *results* contain a touched node
(`memsrv.rs:269`, `cache.rs:114`), so a new node that should now rank first is
invisible to every query already in cache, for the life of the process.
Measured (exp4): after "billing now uses port 9090" was stored, the same
question still returned only the retired "port 8081" — `cache: hit`. Since the
sidecar lives as long as the session, anything learned mid-session is not
recalled for repeated questions. *Fix:* clear the whole cache on `CreateNode`
(and on any `AddFact`/`SupersedeFact` — they change node text, so ranking).

**F3. Recall in the system prompt defeats prompt caching (regression of M1).**
`app/src/extensions/memory.ts:229` appends the per-message recall block to the
system prompt, so the cached prefix changes every run and every turn pays for
the full prompt again. M1 identified exactly this in the Node agent; the
prototype reintroduced it. *Fix:* keep only the *profiles* in the system prompt
(they change rarely; changes are batched to session boundaries) and deliver
per-message recall as a non-displayed custom message (`before_agent_start`
returns `message`), after the cached prefix.

**F4. Recall links Mnemo's own markers as feeders, so steering blames itself.**
`memory.ts:221` links *every* recalled node to the episode as
`SuppliesContext`, including pain and gap markers. The steering design keeps
pain markers out of `feeders_of` on purpose (`steering.rs`, the `DerivedFrom`
comment); the app undoes that. Measured (exp1): the third "vitest not found"
failure blamed a gap node and the earlier pain node; the fifth blamed four
markers. Meanwhile the always-injected **profiles** are never linked, so the
facts most likely to be wrong are the ones never blamed. *Fix:* link only
knowledge nodes (profile facts, lessons, skills, entities); give profile facts
fact-level provenance (F13).

### P1 — the loop is wrong or does nothing

**F5. A recurring failure creates a new pain node every time.**
`steer()` creates a pain node unconditionally; nothing deduplicates across
sessions. Exp1: three identical "vitest not found" nodes, and recall injected
all three. *Fix:* key pain markers by a normalized failure signature; on
recurrence, increment a count fact and log the episode instead of creating a
node. Recurrence count is itself the strongest "this needs a lesson" signal.

**F6. Gap nodes are junk and never resolved (M9).**
A failure with no overlapping feeder creates `gap: <4 sorted tokens>` —
exp1 produced "gap: bash error failed found". It is then recalled and linked
like knowledge. Nothing ever fills a gap (J3 unbuilt). *Fix:* stop creating gap
nodes from tool errors (they are not knowledge gaps); create them only from an
explicit "I don't know X" and resolve them with J3.

**F7. Lessons are token bags and are not linked to their evidence (M7).**
`consolidate.rs` groups by shared tokens: exp1 produced "lesson: bash found",
"lesson: bash found install pnpm", "lesson: run tests", each with only
"seen in N episodes". Line 174 says "cite the evidence so the lesson is
reachable" but emits no `Link`. *Fix:* keep the lexical grouping as the cheap
clustering step and add J1 (a model writes the lesson as a sentence with a
"when … do …" shape, citing source ids), plus `DerivedFrom` links lesson→sources.

**F8. Steering changes weights that ranking does not read.**
Seed score = cosine × area weight + usefulness bias (`search.rs` `search()`);
edge weights only scale *neighbours* in `expand()`. Blame (−0.10) and reinforce
(+0.05) therefore barely change what is recalled next time. *Fix:* fold a
node-level trust score into seed scoring — e.g. `score × (0.5 + trust)` where
trust aggregates its outgoing edge outcomes and usefulness votes — and decay it
toward neutral over time.

**F9. `state_of` renders the log as one line.**
`store.rs:229` pushes a literal `\\n`, so "recent log" reaches the model as a
single run-on line with visible `\n` sequences (seen in exp1's raw state).

**F10. Recall is global: one project's memories leak into another.**
Nodes carry no project, and `search` has no scope. A pain marker or lesson
from repo A is recalled in repo B. *Fix:* every node created during a session
gets `PartOf → project` (and the user profile is the only global node by
default); search takes a project scope and treats cross-project hits as a
discounted area, exactly like `CROSS_AREA_DISCOUNT`.

**F11. Episodes are empty shells.**
Label = the first prompt; log = "bash: ok"; no summary, files, decisions or
outcome. `recall()` filters fact-less episodes out (`service.ts`), so episodic
memory is never recalled at all, and consolidation clusters on prompt words.
This is the missing **session understanding** (§4, L1).

**F12. A project is a `cwd` string.**
`project <cwd>` splits memory across subdirectories, worktrees and moved
clones. *Fix:* identity = git root + normalized `origin` URL (fallback: path),
with the path kept as an alias fact.

**F13. Profiles grow without bound and without provenance.**
Every reflection can add keys; all are injected every turn; there is no size
budget, no "learned in session X from Y", no confidence, no user-facing edit
or forget (`memsrv` has `forget` at `memsrv.rs:602`; the app does not expose
it). Key drift ("package manager" vs "pkg manager") creates parallel facts the
supersede rule cannot catch. *Fix:* fact metadata (source session, evidence,
confidence, last confirmed), a token budget with least-recently-useful
eviction to "archived", canonical-key suggestion from existing keys, and
`/memory edit|forget|pin`.

**F14. The usefulness loop is dead in the new app (M5).**
`mark_useful` exists in `memsrv` and the old Node agent credited reuse; the
Bun app never calls it, so the bias is always zero.

**F15. The default embedder is weak in ways that matter.**
`vec.rs:45` keeps only ASCII alphanumerics — any non-English text embeds as
nothing; no stemming ("install" ≠ "installing"), no stopwords, 256 dims; and
`node_text` embeds kind names and log lines ("created node created as …") as
signal. The remote embedder is opt-in and needs a key (M6). *Fix:* a small
local model in the sidecar (e.g. fastembed-rs / bge-small, offline, ~30 MB)
as the default, hashing as the fallback; embed label + facts only.

**F16. Reflection is ungated and unverified.**
One model call after *every* run regardless of value; it can store a guess, a
secret, or text that came from a file or web page as a "user preference"
(memory poisoning — the profile is then injected with system-prompt authority
into every later turn). Nothing checks a new fact against what memory or the
code already says (M10). *Fix:* run reflection at natural boundaries (end of
session, before compaction, after a user correction) rather than every run;
redact secrets before writing; tag each fact's source (user said / observed in
code / inferred); require user-said or observed-twice for profile facts,
otherwise store as "candidate"; check contradictions and ask.

**F17. Skills are created only if the model volunteers.**
`create_skill` exists but nothing detects a procedure worth keeping; skills
are written to the user-global directory even when they are project-specific;
which skills a session actually loaded is not tracked; `update_skill` is a
whole-file rewrite (the J11 design requires anchored patches); nothing
evaluates or reverts a skill. (§4, L3.)

**F18. Sub-agent episodes are orphans.**
A child session creates its own episode with no link to the parent episode,
so delegated work is not attributable and cannot be credited or blamed with
the parent's outcome.

**F19. Consolidation runs only on clean shutdown.**
A killed terminal skips it; nothing runs between sessions; J2–J10 (merge,
salience review, edge maintenance, compaction, training rows) are unbuilt.

**F20. `memory_steer` cannot carry a correction.**
`steer` supports `fix: {node, fact, new_key, new_value}`; the tool exposes only
free text, so the model cannot say "the test command fact is wrong, it is X".

### P2 — quality, cost, unused capability

- **F21. The fix that worked is never stored.** A failure is recorded; the
  next successful step after it (the recovery) is not, so the most valuable
  procedural knowledge — "when `vitest not found`, run `pnpm install` first" —
  is lost every time.
- **F22. Graph features that exist and are unused:** `ActivatedWith`
  (co-retrieval, Hebbian), `PartOf`, `PushContext` context chunks, `history`,
  `recall_brief`, `remember`'s area routing. Either use them (F10 needs
  `PartOf`; co-recall could feed `ActivatedWith`) or delete them.
- **F23. No measure of evolution.** `memeval` measures retrieval on a fixed
  corpus; nothing measures whether session N+1 is better than session N
  (fewer repeated failures, fewer user corrections, fewer turns to done).
- **F24. Every query re-embeds every node on a cache miss** (`build_vectors`
  in `search`). Cheap with hashing (exp3: <5 ms at 8k nodes); expensive with a
  real model. Keep vectors incrementally (they are derived state) once F15
  lands.
- **F25. Secrets.** Trace lines are redacted; memory writes are not. A key
  pasted into chat can be reflected into a profile and re-sent to the
  provider in every later system prompt.

---

## 3. Missed chances — signals and features already in hand

| Already available | How it would teach Mnemo |
|---|---|
| **Approval "No, do X instead"** (policy extension) | The user's own words about how to work. Today it goes to the model and is forgotten; it should be a candidate user/project preference ("don't run migrations without asking", "put notes in docs/"). |
| **User corrections in chat** (pi `input` event) | "no, use pnpm", "that's wrong", "actually…" — the highest-quality learning signal there is. Detect and route to reflection immediately, with the correction as evidence. |
| **Test and build results** (`bash` output) | Red→green is a reward; green→red after an edit is blame with a precise target. Parse common runners' summaries. |
| **Git** | Files changed and the diff at session end = what was actually done; a commit = the user accepted the work. |
| **pi compaction** (`session_compact`, `generateSummary()`) | pi already writes a structured summary of long sessions; storing it on the episode is session understanding for free. |
| **pi session files** (`~/.mnemo/agent/sessions/*.jsonl`) | Offline replay: backfill memory from past sessions (and from a user's existing pi sessions) with the same reflection pipeline. |
| **Skill loads** (a `read` of a `SKILL.md`) | Which skill was in force when a run failed or succeeded — the input J11 needs. |
| **`AGENTS.md` / `CLAUDE.md` in the repo** | Import as project facts on first run; export learned project facts back as a proposed `AGENTS.md` section, so knowledge is shared with the team and other tools. |
| **`pi-codemode`** (sandboxed JS that can only call tools) | The safe sibling of `ipy_run` for "write one program instead of N tool calls". |
| **`pi-durable`** | Crash-resumable sessions; also a home for scheduled memory jobs. |

---

## 4. What would make it actually self-evolving

### L1 — Session understanding

At the end of a session (and at every compaction) write an **episode record**:

| Field | Source |
|---|---|
| goal | first prompt + clarifications, summarised |
| outcome | done / partial / abandoned — from tests, commit, user's last message |
| what was done | files touched + `git diff --stat`, tools run |
| decisions | "chose X over Y because Z" sentences from the transcript |
| problems → fixes | failure signature → the step that resolved it (F21) |
| open threads | TODOs, unanswered questions, "next time" |
| knowledge used | profile facts, lessons, skills recalled and actually referenced |

Then: "**Continue where we left off**" (recall the latest open threads for
this project at session start), "**what did we do on X**" (episodic search with
dates), and a `/sessions` timeline. The record is written by pi's
`generateSummary()` with a structured prompt, then *checked* against git and the
tool log so it cannot claim work that did not happen.

### L2 — Credit assignment

Every piece of knowledge injected into a turn carries an id. At the end of a
run, the outcome (tests, user correction, denial, error, success) is attributed
to the ids that were in context **and referenced** (the old lexical
`creditUse` was a good start). Trust lives on the node and the fact, decays
toward neutral, and multiplies the recall score (F8). A fact that keeps being
contradicted is demoted to "disputed" and the user is asked.

### L3 — Procedural learning: skills Mnemo writes, uses, and fixes

1. **Detect.** After each session, compare its successful tool-call sequence
   (normalized: tool + command shape + file roles) with earlier episodes in the
   project. A shape seen in ≥2 successful sessions, or one long successful
   procedure the user asked to repeat, is a candidate.
2. **Draft.** A model writes the `SKILL.md` from the episodes: when to use it,
   steps, commands, pitfalls (from the pain markers on those episodes),
   verification. Scope: the project (`<repo>/.agents/skills/`, so it is shared
   with the repo) or the user (`~/.mnemo/agent/skills/`) depending on whether
   the steps reference project files.
3. **Approve.** Shown as a diff in the approval dialog ("Mnemo wants to save
   a skill: release-notes"); auto-saved only in yolo.
4. **Track.** Record every load (the `read` of its `SKILL.md`) on the skill
   node with the run's outcome.
5. **Improve.** When a run that loaded the skill fails with a signature the
   skill does not cover, propose an **anchored patch** (J11), applied next
   session, reverted automatically if the same signature recurs.
6. **Retire.** Unused for N sessions, or failing more than it succeeds:
   retire (moved aside, recoverable).

Beyond skills: **checklists** (pitfalls per area, injected when that area is
touched — "migrations: run `db:generate` after editing schema.prisma"),
**commands** (the project's verified build/test/lint/run commands, auto-learned
from successful runs), and **file map** (what lives where, learned from reads).

### L4 — Consolidation as a "sleep" runtime

Between sessions (on idle, on exit, or `mnemo memory improve`), run the jobs in
`memory-runtime-design.md` in its phase order, report-only first: J2 merge
duplicates, J5 salience review (recurring pain → lesson; pain followed by a
fix → resolved), J6 edge maintenance, J1 distill lessons as sentences, J4
contradiction sweep, J9 compaction, and forgetting (archive what has not been
useful in N sessions). Every run produces a short report the user can read.

### L5 — Self-assessment

A per-project scorecard Mnemo keeps about itself: repeated-failure rate,
user-correction rate, turns-to-done for recurring task types, recall precision
(recalled and referenced / recalled), skills used / skills succeeding. Shown by
`/memory stats`; the regression harness (§5 phase E) asserts it improves on a
repeated-task benchmark.

### Memory types, scoped

| Type | Scope | Example |
|---|---|---|
| preference | user | "comments explain why", "terse answers" |
| convention / command | project | "pnpm", "test: pnpm vitest run" |
| decision | project | "chose zod over yup (bundle size), 2026-10-02" |
| pitfall / lesson | project (or user) | "after editing schema.prisma run db:generate" |
| procedure (skill) | project or user | `release-notes` |
| episode | project | session record (L1) |
| entity map | project | "billing → services/billing, port 9090" |

---

## 5. Order of work

Each phase lands green and is measured; none needs an API key to verify
(the faux model scripts sessions; exp1–exp4 become tests).

**Phase A — correctness (first).** F1 single writer, F2 cache invalidation,
F3 recall as a message + stable profile prompt, F4 link only knowledge, F5
pain dedupe with counts, F6 no gap nodes from tool errors, F9 log rendering,
F14 usefulness credit, F25 redact before memory writes. *Verify:* exp1–exp4
as regression tests; a two-process test; a prompt-prefix stability test.

**Phase B — session understanding and scoping.** L1 episode records (with
git/tool-log grounding), F10 project scope via `PartOf`, F12 git identity,
F21 failure→fix capture, approval feedback and chat corrections as
preference candidates, F13 provenance + budget + `/memory edit|forget|pin`,
"continue where we left off". *Verify:* scripted multi-session runs where
session 3 must use what session 1 decided and session 2 fixed.

**Phase C — procedural learning.** L3 detect → draft → approve → track →
patch → retire; checklists and verified commands. *Verify:* a procedure done
twice becomes a skill proposal; a failing skill gets a patch that is reverted
when the failure recurs.

**Phase D — the sleep runtime.** L4 jobs, report-only then apply, with
revert; local embedder (F15) and incremental vectors (F24); trust-weighted
ranking (F8). *Verify:* `memeval` floors hold; a polluted journal (exp1) is
cleaner after a run, with every change revertible.

**Phase E — measurement.** L5 scorecard; a repeated-task benchmark (same
project, 5 sessions, scripted user) run with and without memory, published
with its method (replaces the 3-task claim, M17).

---

## 6. Things to add beyond the loop

- **Memory you can see and steer.** A `/memory` browser (profiles, lessons,
  skills, episodes) with edit, forget, pin, and "why do you believe this?"
  (provenance → the session and message it came from).
- **"Teach" moments.** When Mnemo learns something with low confidence, ask in
  one line ("Should I remember that this repo uses pnpm?") instead of guessing.
- **Team memory.** Export project memory to `AGENTS.md` / `.agents/skills/` in
  the repo so teammates and other agents benefit; import theirs.
- **Backfill.** `mnemo memory import` replays existing pi / Claude Code /
  Codex session logs into memory with the same pipeline.
- **Per-branch working memory.** What is in progress on this branch, cleared
  on merge.
- **Budget-aware recall.** A token budget for injected memory per turn, filled
  by expected usefulness, not by a fixed k.

---

## 7. Self-review of the prototype (my own code, plainly)

F3, F4, F11, F13, F14, F16, F17 and F18 are in code written this week
(`app/src/extensions/memory.ts`, `skills.ts`, `agents.ts`). F3 repeats a
finding (M1) the repository had already documented; it should have been read
first. The extension tests pass because they test that the plumbing works
(facts cross sessions, steering fires), not that what is learned is *good* or
that recall stays clean over many sessions — exp1 is the test that was missing.

---

## 8. Reproducing the measurements

The four scripts drive the release `memsrv` through the app's own
`MemoryService`/`MemoryClient`:

| | What it does | Result |
|---|---|---|
| exp1 | 3 profile facts, 6 simulated sessions (recall → link → failure steer / success), consolidate, then search | duplicated pain nodes (F5), junk gap node (F6), markers blamed (F4), token-bag lessons with no links (F7), `\n` in state (F9) |
| exp2 | two `memsrv` processes on one journal | B blind to A's write; both allocate node 1 (F1) |
| exp3 | 500 → 8 000 nodes | writes 0.07 ms, replay 18 ms at 8k, dump 41 ms — performance is not the problem; repeated queries were cache hits (led to exp4) |
| exp4 | search, store a correction, search again | the correction is invisible: `cache: hit` with the retired value (F2) |

They are in `research/audit-experiments/` (run from `app/`:
`bun ../research/audit-experiments/exp1.ts`; needs a built `memsrv`). Phase A
turns each into a regression test under `app/test/` and `memory-layer/tests/`.
