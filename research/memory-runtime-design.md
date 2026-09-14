# The memory layer's own runtime — a self-improvement environment

*A design. The ask: give the memory layer a runtime of its own, so it can work
on itself without a session open — using the user's default model, or one set
for it specifically.*

Companion document: `research/agentic-capability-review.md` (the findings this
runtime is meant to act on).

---

## 1. Why memory needs its own runtime

Today the graph only changes when a session changes it: `steer()` when
something failed, `consolidate()` when a CLI is run, `remember()` when the model
decides to write. Three consequences:

1. **Nothing reads the journal as a whole.** The signals are all there — open
   `gap:` nodes, pain markers that recur, episodes that taught nothing, facts on
   the same key that disagree — and no process looks for them.
2. **The cheap jobs are lexical.** `consolidate()` clusters by token overlap,
   because it must run with no model and be idempotent. That is the right
   default and the wrong ceiling: "lesson: checkout deploy rollback" is not a
   sentence anyone would write, and a model is available.
3. **The expensive jobs never happen.** Answering a gap requires research;
   merging forty empty episodes requires judgment; generating eval cases from
   real episodes requires reading them. All of it is unattended work.

So: a runtime that runs *bounded jobs* on the graph, on a schedule, with its
own model budget — the memory layer's analogue of sleep.

## 2. What it is, and what it is not

**It is a job runner.** One job = one bounded piece of work = a small number of
LLM calls with a fixed prompt, a fixed output schema, and a fixed set of
permitted ops. Jobs are code; the model fills in content.

**It is not a second agent.** No free-form loop, no shell, no file editing, no
tool-calling beyond an explicit allowlist per job. The main agent's loop is
where the model decides; this is where it *labels, merges, summarises and
answers* — and the ops are chosen by the runtime, never emitted by the model.
That single rule is what keeps a self-improving memory from becoming a
self-modifying program.

**It is not a replacement for session-time memory.** The agent still writes
facts, steers failures and recalls. The runtime works the backlog.

## 3. Where it lives

| Option | Pros | Cons |
|---|---|---|
| Rust binary in `memory-layer/` (`memself`) | runs with no Node; the journal, the lock and the `Op` code are right there; same process family as `memsrv`/`memeval`/`mempolicy` | needs its own provider client, auth reading and retry policy (embeddings in `remote.rs` are a precedent, not a framework) |
| **A TypeScript job runner in `agent/` (recommended)** | reuses `~/.mnemo/auth.json`, the provider/model catalogue, the trace store and the hooks engine — every piece of infrastructure this needs already exists; a `mnemo memory improve` subcommand is a few lines in `bin/mnemo.ts`; the TUI can call the same code | requires Node (already a hard requirement of the product) |

**Recommendation: the TypeScript job runner**, with one structural rule that
keeps it honest — *all* memory mutation goes through `memsrv`'s JSON-RPC
methods (`fact`, `episode`, `link`, `set_area`, `steer`, `good`, `commit_log`,
`consolidate`, and the wrappers `remember`/`recall_brief`). It is a client of
the same surface every other process uses, so the journal stays the single
source of truth and the runtime can be deleted without leaving a mark on the
architecture.

Place it in `agent/src/memruntime/` (`jobs/`, `runner.ts`, `config.ts`,
`model.ts`), with `mnemo memory …` as the CLI entry point.

## 4. The model, and how it is chosen

The runtime needs a model for three of its jobs and no model for the rest.
Configuration, in order of precedence:

1. `--model provider/model` on the command line;
2. `MNEMO_MEMORY_MODEL` in the environment;
3. `~/.mnemo/memory-runtime.json` → `{"model": "...", "budget": {...}}`;
4. **the stored default** in `~/.mnemo/auth.json` — the same default the TUI
   uses, so a user who has configured Mnemo once has configured this.

No key anywhere → the runtime **says so and exits non-zero** for model jobs
while the no-model jobs keep working. Silence is the one unacceptable outcome:
a self-improvement daemon that quietly does nothing is indistinguishable from
one that is broken.

`memory-runtime.json` also carries the operational settings: per-run and
per-day budget (tokens and wall-clock), cadence, which jobs are enabled, and
`"apply": false` (see §6). `mnemo memory config` prints the resolved settings
and where each value came from — the same "explicit, never guessed"
discipline the rest of the repo applies to paths.

## 5. The jobs

Each job states its input, what it does, and the ops it is allowed to emit. The
"model" column says whether it needs one.

| Job | Model | Input | What it does | Ops |
|---|---|---|---|---|
| **J0 consolidate** *(exists)* | no | Episodic + Salience nodes | lexical lesson extraction, idempotent | `CreateNode`, `SupersedeFact` |
| **J1 distil** | yes | a cluster from J0, or episodes in a time window | names the lesson in a sentence, cites its sources, replaces the token-shaped label | `CommitLog`, `AddFact`, `SupersedeFact` |
| **J2 merge** | no | nodes with identical fact sets; empty episodes | merges duplicates, links the survivors `PartOf`, retires the rest by superseding their `sources` fact | `Link`, `SupersedeFact`, `CommitLog` |
| **J3 fill gaps** | yes | open `gap:` nodes | searches the graph first; if the answer is there, links it and marks the gap resolved; if not, asks the model *with a citation requirement* — every claim must name a node id, or the gap is marked `needs-human` | `Link`, `AddFact`, `CommitLog` |
| **J4 stale sweep** | yes | active facts sharing a key across nodes | finds contradictions, proposes supersede with the newer evidence cited | `SupersedeFact`, `CommitLog` |
| **J5 salience review** | no | Salience nodes + later outcomes | recurring pains → a lesson; pains followed by success on the same episode → marked resolved | `CreateNode`, `AddFact`, `CommitLog` |
| **J6 edge maintenance** | no | edges with outcome history | reweights dead or consistently-failing edges, reports orphans | `Reweight`, `Unlink` |
| **J7 area hygiene** | yes | nodes whose area disagrees with their content | proposes `SetArea` with a one-line reason | `SetArea`, `CommitLog` |
| **J8 eval cases** | yes | episodes with facts | proposes retrieval cases (question → expected node id) for `memeval` | none — writes a review file |
| **J9 compaction** | no | node counts, ages, fat logs | proposes merges/retirements as a *quarantine list*, never deletes | none (report only) |
| **J10 training rows** | no | steer ops + later outcomes | emits mempolicy training rows (`M13` in the review) | none (file) |
| **J11 skill patch** | yes | lesson nodes + pain markers + the skills the sessions that produced them actually loaded | proposes an edit to the `SKILL.md` the lesson applies to — anchor, replacement, reason, evidence ids — and applies it only under the rules in §5.1 | `CommitLog` + `AddFact` on the skill node; the file itself is written by the `patch_skill` tool, never by the job |

J0, J2, J5, J6, J9 and J10 need no model at all — they are graph arithmetic, and
they are the ones that can run on a cron with no key configured.

### 5.1 J11 — how a skill gets better

Mnemo can already *create* a skill (`create_skill`). What it could not do was
improve one: changing a skill meant overwriting the file wholesale with
`write_file`, leaving no record of what changed, why, or how to undo it. That is
scribbling, not learning. The loop that closes it has four parts.

**What it reads.** Lesson nodes (Semantic, from J0/J1), pain markers (Salience),
and — the part that makes this possible at all — the *Procedural* node for each
skill the sessions that produced those lessons actually loaded. A lesson without
a skill attached is a fact; a lesson attached to the skill that was in force when
it was learned is a patch candidate.

**What it proposes.** Never a rewrite: an edit expressed as an anchor plus a
replacement — the shape `patch_skill` accepts, and the only shape it accepts — a
one-line reason, and the evidence ids it is answering: the lesson and, where
there is one, the pain marker. A proposal with no evidence is rejected before a
model is called, not after.

**How it is applied.** Through the same `patch_skill` tool the model uses in a
session. One writer, one set of refusals (stale hash, ambiguous anchor, path
outside Mnemo's own roots, invalid frontmatter), one history copy under
`~/.mnemo/skill-history/<name>/`. The runtime does not get a private door into
the file system; if the tool refuses, the job reports the refusal as its result.

**How it is judged.** Not by the model, and not in the same run. The signal is
recurrence: the next session that loads the patched skill and hits *the same pain
signature* is evidence the patch did not work. That event — and only that event —
triggers the revert (copy the previous body back from history) and writes a
Salience node recording that this patch failed, which is itself the lesson the
next proposal is built on. A patch that is never contradicted is simply a patch
that has not been tested yet, and is recorded that way.

**What it never does.** Patch a skill outside `~/.pi/agent/skills` and project
`.agents/skills` (never `.claude/`, which belongs to another tool, and never a
package directory). Patch during the session that diagnosed the problem, so a
model cannot mark its own homework within one turn. Delete: `retire_skill` marks
a skill retired and moves it aside; the file survives its retirement.

## 6. The safety model

Five rules, each closing a specific way this goes wrong.

**R1 — The model never chooses ops.** A job's code decides what may change; the
model supplies text inside a schema (a lesson sentence, a set of node ids, a
yes/no with a reason). A malformed or off-schema answer is rejected and logged;
it is never coerced into an op. This is the difference between "an LLM edits
your memory" and "an LLM helps you file it".

**R2 — Dry run is the default.** `mnemo memory improve` prints the ops it would
emit, with the nodes it read and the reason for each. `--apply` commits them.
The TUI's version shows the same list before anything is written.

**R3 — Every run is budgeted and leased.** Tokens, dollars and wall-clock per
run and per day, with a hard stop; a lease file (`O_EXCL`, pid, stale detection
— the same pattern the schedule daemon already uses) so two runtimes, or a
runtime and a session, cannot interleave. The journal's own lock is the last
line of defence, not the first.

**R4 — Supersede, never delete; provenance always.** No job may remove a node
or erase a fact — the graph's model does not allow it and the report layer
would not survive it. What a job creates carries `origin: memory-runtime` in
its log entry, and what it supersedes records its own node id as the source.
Everything it does is revertible by appending compensating ops, and each run
gets a `run:<id>` tag so `mnemo memory revert <run-id>` can do exactly that.

**R5 — Everything is visible.** A run writes trace spans (`~/.mnemo/logs/`,
same redaction), prints a summary (ops proposed/applied, tokens, cost,
duration), and the TUI's Memory overlay shows the last run's line. Nothing the
runtime does is invisible, because the whole project's premise is that memory
you cannot inspect is memory you cannot trust.

## 7. Interfaces

```bash
mnemo memory status                 # graph hygiene: gaps, contradictions, empty
                                    # episodes, orphans, last run — reads only
mnemo memory improve                # dry run of the enabled jobs
mnemo memory improve --apply        # commit, budgeted and leased
mnemo memory improve --job J3,J4    # a subset
mnemo memory improve --model deepseek-v4-flash
mnemo memory revert <run-id>        # compensating ops for one run
mnemo memory config                 # resolved model, budget, cadence, sources
mnemo memory daemon [--interval 24h]
```

In-session: `/memory improve` (same code path, dry run first), and the palette
entry comes free once the agent's commands are surfaced (P2 in the
command-surface review).

**memsrv**: prefer computing from what exists — `dump` (id/kind/area/label/
facts/feeders), `state`, `stats`, `search`. If a job needs a read the surface
cannot express (candidate contradictions, unattached edges), add a **read-only**
RPC (`candidates {kind}`) rather than letting the runtime parse the journal
file itself. The journal stays the sidecar's business.

## 8. Phasing

| Phase | Content | Acceptance |
|---|---|---|
| **P0 — report only** | `mnemo memory status`: empty episodes, open gaps, same-key facts that disagree, dead edges, node count by area. No model, no writes. | runs against a real journal in seconds; the numbers are checkable by hand |
| **P1 — dry runs** | J1, J3, J8 behind `--dry-run` (still the default), budget-capped, model from the stored default | a dry run prints ops with reasons; a full day of runs costs pennies |
| **P2 — apply** | `--apply`, the lease, run tags, `revert`, trace spans, `/memory improve` | an applied run is reproducible, revertible, and visible in `mnemo traces` |
| **P3 — cadence** | `mnemo memory daemon`, J4/J5/J7 on a schedule, J10 rows for mempolicy | runs unattended for a week; each run's report stands alone |
| **P4 — goal-directed** | the runtime picks its next job from the graph's own signals (worst gap first, biggest contradiction first), and reports what it could not do | the backlog shrinks without a human choosing |

## 9. How we know it worked

- **No regression, ever:** `memeval --hash` before and after each apply run, in
  the run report, against the pinned floor (73/77/0.743). A run that regresses
  is reverted, and the revert is recorded — which is only safe because the ops
  are in the journal.
- **Graph hygiene deltas:** empty episodes, open gaps, contradictions and
  orphans should trend down for a real journal. If they do not, the jobs are
  wrong, not the metric.
- **Cost per useful op:** tokens spent ÷ ops that survived a human glance. A
  job that proposes forty merges nobody accepts is a job to delete.
- **Held-out checks on the learning jobs:** J10's rows train `mempolicy` on a
  split, never on the whole history (the review's M13).
- **Eval corpus growth with review:** J8's proposals enter `memeval` only after
  a human accepts them — a system that writes its own exam and grades itself
  measures nothing.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Self-reinforcing memory (it rewards what it retrieves) | J5/J10 use *outcomes*, not retrievals, as the signal; thumbs-down from the TUI is the corrective channel (review M5) |
| Runaway cost | per-run and per-day budgets, hard stops, and the resolved config printed every time |
| Two writers, torn state | the lease (R3) plus the journal's advisory lock; memsrv remains the only writer path |
| A bad merge loses knowledge | supersede-never-delete (R4); `PartOf` links keep the merged-away nodes reachable; `revert <run-id>` |
| Hallucinated lessons that read well | J1/J3 must cite node ids; a citation to a node that does not exist fails the job, and the lesson is not written |
| The runtime becomes a second agent | §2's rule: fixed jobs, fixed schemas, no shell, ops chosen by code. A job that wants a shell is a signal to run the main agent instead |
| Users forget it is running | every run leaves a line in the TUI's Memory overlay and a trace span; `mnemo memory status` shows the last run's cost |

## 11. What not to build

- **No autonomous code writing or execution** — that is the main agent's job,
  with a person in the loop.
- **No self-grading** — the runtime may propose eval cases; it may not grade
  its own lessons as correct.
- **No rewriting history** — the journal is append-only; "fixing" a bad run
  means compensating ops, not editing lines.
- **No second copy of the graph** — the runtime reads through `memsrv` like
  everything else; a cached mirror would be a second source of truth within a
  week.
- **No embedding self-training**, no cluster summaries, no journal GC without a
  human-read dry run — the standing non-goals in
  `research/memory-layer-improvements.md` still hold.
