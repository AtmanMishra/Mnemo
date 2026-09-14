# Agentic capability review — memory and the Python kernel

*What would make Mnemo meaningfully more capable, stated as findings with
evidence and a way to measure each one. Not a feature wish-list: every item
below is either a defect in something already shipped, a lever that is not being
pulled, or a limit worth naming out loud.*

Companion document: `research/memory-runtime-design.md` — the memory layer
getting its own runtime to act on the findings here by itself.

---

## 0. What "maximum" means here

The thesis this project is built on is that capability comes from the *system*
around the model — memory that compounds, tools that compose, verification that
catches the model's own mistakes — rather than from parameters. So "maximum"
is not one number. There are exactly five levers in this codebase:

1. **What the model knows before it starts** — recall quality, memory shape.
2. **What it can do in one step** — tools, and especially the kernel, where a
   step can be a whole program.
3. **What it can do at all** — delegation, scheduling, self-extension.
4. **What it can check** — verification, evals, traces.
5. **How much context it wastes** — compression, caching, budgets.

Everything below is filed under one of those. Where a claim is measurable, the
measurement is named; where it is not yet, that is said.

---

## 1. What is already right (do not relitigate)

- **Memory is push, not pull.** `recallFor` runs before every model call, so a
  small model with no tool-calling discipline still gets its memory
  (`agent/extensions/memory-layer.ts`). Relying on the model to decide to
  search is how memory silently stops working.
- **The journal is the source of truth.** Replay reconstructs state exactly;
  facts are superseded, never erased; every writer takes the same lock. This is
  what makes a self-improving memory safe to attempt at all.
- **The kernel is programmatic tool calling.** One program instead of N round
  trips, with the same approval path as a normal call — the single biggest
  structural advantage in the repo, and the least exploited (see §3).
- **Recall is framed as candidates, never as fact** — the difference between
  "here is what might be relevant" and "here is the truth" is the difference
  between a memory system and a hallucination amplifier.
- **Traces nest across processes.** A delegation tree is reconstructible from
  the log; subagents inherit parent session/span ids.

---

## 2. The memory layer

### 2.1 The read path

**M1 — The recall block sits in the system prompt, so memory invalidates the
prompt cache on every turn.** *(category 5 — the most expensive item here)*
`before_agent_start` appends the recalled block to `systemPrompt`. Provider
prompt caching is a prefix cache: changing the system prompt discards the
cached prefix for the whole conversation, every turn, for every session with
memory enabled. The more memory works, the more it costs.
*Fix:* keep the system prompt byte-stable for the session and deliver recall as
its own message immediately before the user turn (a pinned `user`-role block),
or as a tool result. Same information, cache-safe.
*Measure:* cache-hit rate and cost per turn, before/after, with the same prompt
sequence. This is the cheapest large win in the document.

**M2 — Recall selection is crude: `k=3` and a relative 0.6 cutoff.**
No diversity (three paraphrases of one node), no dedupe against what was
already injected last turn, no budget in tokens — only a hit count. A fat node
can spend the whole block (`summariseState` caps one node at 6 lines/400 chars,
which is a cap, not a budget).
*Fix:* MMR-style diversity over the hit list; skip nodes already injected in
the last N turns; budget by tokens; prefer nodes whose state *changed* recently
(a superseded fact is a signal that this memory is live).
*Measure:* recall precision on the eval corpus — does the injected block
contain the node the query needed, with fewer wasted lines.

**M3 — Routing is a hand-written English cue table and the ANN path is
unreachable.** `route_query` scores areas by literal phrases ("fail, error,
broke" → Salience); a query without them gets no bias. `search_ann` exists in
the crate with a test proving it matches brute force, but `memsrv` calls
`search` (`docs/MEMORY.md`, "Open threads"; issue #5). Brute force is genuinely
fine at this size — the problem is that the decision is invisible.
*Fix:* either wire ANN behind a node-count threshold, or delete it and say in
the code why brute force is the design. For routing, the honest upgrade is
learning the router from the journal (which area the *retrieved* node actually
lived in), not hand-writing more cues.
*Measure:* memeval with routing on/off; a mis-routed query must not lose to a
correctly-routed one by more than the cross-area discount.

**M4 — One hop of expansion, no reranker, no query expansion.** `expand()`
scores neighbours at `seed × 0.5 × edge_weight`, dead edges propagate nothing.
That is a good rule, applied once. P2 root-caused the miss the project left
failing and B3 closed exactly one case with a single alias entry, gated on two
measurements — the process is right.
*Fix:* a bounded second hop (only along `SuppliesContext`, only when the seed
score is above a floor), and a cheap cross-encoder-style rerank of the top-k by
token overlap with the query *plus* the retrieved node's area. Both behind the
existing memeval gate.
*Measure:* `memeval --hash` Hit@1/Hit@3/MRR must not regress; real-embedding
run reported separately (the hash numbers are a floor, not the product).

**M5 — The usefulness feedback loop is one-sided.** `mark_useful` exists, the
recall hook votes every retrieved node "useful" fire-and-forget, and the TUI
has no thumbs-down wired (`STATUS.md`, AREA 11 — "the thumbs-down channel is
the balance"). Net effect: counters drift upward forever, and the ±0.02 bias
they feed stops meaning anything.
*Fix:* stop auto-voting on retrieval — vote on *use* (a node whose content
appears in the assistant's answer or in a follow-up tool call), and decay
counters by age. Wire the TUI thumbs-down onto the same RPC.
*Measure:* counters over a real journal: distribution of useful/unhelpful
should be non-degenerate, not monotonic.

**M6 — Embeddings are opt-in, and the eval says that is expensive.**
`HashingEmbedder` is the default; the OpenRouter embedder activates only when
`OPENROUTER_API_KEY` is present *and* `SEA_MEMORY_REMOTE=1` is set by the
caller. The measured gap is large: 68%/73%/0.697 hashing vs 82%/95% (real) on
the same corpus.
*Fix:* invert the default when a key exists — remote by default, `--hash` to
opt out — and make the model choice visible in the memory pane. The disk cache
(`sha256(model ‖ text)`) already makes this cheap after the first run.
*Measure:* the two eval rows, reported side by side in every eval run.

### 2.2 The write path

**M7 — Consolidation is lexical, so lessons are token-shaped.** `consolidate()`
needs ≥2 sources sharing ≥2 tokens, which is cheap, idempotent and honest —
and it produces "lesson: checkout deploy rollback" rather than a sentence
someone would read. The model is available; the job is not given to it.
*Fix:* this is a job for the memory runtime (§ companion doc, J1): the lexical
pass proposes clusters, the model names the lesson and writes the sources fact.

**M8 — Empty episodes are still created eagerly.** Every pi session creates a
`TaskEpisode`, which is why the old pane listed 45 rows of
`pi session 2026-08-25T03:23:42Z`. The pane now sorts by fact count, so the
symptom is hidden, not fixed.
*Fix:* create the episode on first *write* (fact, log line, or steer), not on
session start. A session that learned nothing leaves no trace.

**M9 — Gap nodes are created and never filled.** `steer()` writes a
`gap: <tokens>` node when no feeder is implicated — a genuinely good instinct —
and nothing in the system ever answers those gaps.
*Fix:* the runtime (J3) treats open gaps as its backlog, and the TUI shows
them; a gap that is filled gets the answer linked and the gap marked resolved.

**M10 — Nothing checks a new fact against what memory already believes.**
`memory_write_fact` appends; contradictions are resolved later, if ever, by
steering. Two sessions can leave the graph asserting two ports.
*Fix:* at write time, embed the (key, value) pair, look for an active fact on
the same key with a high-similarity but contradictory value, and either
supersede it (with provenance) or flag the node for review. The embeddings are
already computed for the node.
*Measure:* a "contradiction sweep" report over a real journal, before/after.

**M11 — Provenance stops at the edge.** Nodes carry `DerivedFrom` to aspects
and episodes, but not the session or span id that created them, so "why does
this node exist" is answerable only for the cases someone thought about.
*Fix:* stamp `session`/`span` into the fact or the creation log entry; the
trace store has both.

**M12 — Retrieval quality is not enforced in CI.** The project's own rule is
that every retrieval change is measured against pinned `memeval --hash` numbers
(73%/77%/0.743) — and `ci.yml` does not run `memeval` at all. The guardrail
exists as a discipline, not as a gate, which means it depends on whoever is
reviewing.
*Fix:* a `memeval --hash` job with the pins asserted, no network, seconds.
This is the single cheapest item in the document and it protects every other
memory change.

### 2.3 Learning

**M13 — The learner is real, the data is not.** `mempolicy` was fixed
(standardised features) and proved on a synthetic fixture: learned 100%/100%/
100% vs heuristic 22%/0%/0%. On the real journal it reports "nothing to learn
from" — zero examples — because nothing logs the (features → outcome) rows a
policy needs.
*Fix:* every `steer()` already knows its features (edge weight, failure
history, token overlap) and every later outcome is in the journal. Emit one
training row per steer and let the runtime retrain on a schedule.
*Measure:* policy accuracy on a held-out split of real journal data; the
heuristic stays shipped until the learned one beats it *on real data*.

**M14 — There is no per-turn success signal.** The only outcome the system
sees is the eval's task result. Everything else — tool errors, retries, the
user rephrasing the same request, a turn that ends with a failed test — is
already in the traces and thrown away.
*Fix:* derive a turn-quality score from what is logged (tool error rate,
retries, stop reason, follow-up correction) and write it onto the episode. This
is the substrate for M13 and for "does memory actually help" without a
benchmark.

**M15 — A project's conventions enter memory only if someone asks.**
There is no bootstrap pass: open a repo for the first time and memory knows
nothing about the stack, the test command, or the house rules, so the first
session re-derives them from scratch.
*Fix:* `/init` (issue #8) — a one-shot pass that reads the repo's manifests and
the project context file and writes a small set of Spatial/Procedural facts it
can cite later.

### 2.4 Evaluation

**M16 — The corpus is small and one-signed.** n=22, mostly single-area;
Hit@1 73% (hash) means roughly six misses, and the project has already spent a
review cycle deciding one was a corpus gap rather than a code bug.
*Fix:* the runtime generates candidate cases from real journal episodes (a
question the memory *should* answer, from the facts it holds) — human-reviewed,
because an eval you generate and grade with the same model measures nothing.
Then the constraint-persistence and abstention categories from
`docs/EVAL-RESEARCH.md`, which are the two most likely to expose real bugs.

**M17 — The headline claim is three tasks old.** "3/3 with memory vs 0/3
without" was a five-pair corpus's predecessor, on a model that is no longer
the default. It is still printed in the README.
*Fix:* re-run `agent/eval/memory-eval.mjs` and publish the number with its
date, or delete the claim. A stale number in a README is worse than no number.

---

## 3. The Python kernel — the most under-used lever

`ipy_run` is not a tool, it is an execution model: the model writes one program
that can call forty tools instead of forty round trips, and the same approval
gate and permission rules apply in-kernel (`agent/src/tools/kernel_tools.ts`).
The kernel's dispatcher already includes every Mnemo tool — including the
memory tools and MCP tools (`agent/extensions/sea-tools-inline.ts`), which
means a program can search memory, spawn subagents and build harnesses.

That capability is barely used, and the reasons are mechanical:

**K1 — No per-call timeout on the in-kernel channel.** The program is bounded
(`timeout_ms`, default 120s) and the kernel is killed when it expires, but a
single `tools.<name>()` that never returns hangs the kernel with no host-side
bound. Known and documented as a "add one if that ever bites" (issue #6).
*Fix:* per-call timeout in the dispatcher, converted to a Python `ToolError`
the program can catch — an unbounded call becomes an exception in the program,
which is exactly what a program is for.

**K2 — No resource bounds on the kernel process.** Memory and CPU are
unbounded; one recursion kills the agent process or the box (issue #11).
*Fix:* address-space and CPU-time limits at spawn (job objects on Windows,
`setrlimit`/cgroup on Unix), surfaced as a tool error.

**K3 — A timeout silently throws the namespace away.** On expiry the kernel is
killed and the *next* call transparently respawns a fresh one with an empty
namespace — which reads to the model as "my variable disappeared" with no
explanation.
*Fix:* say it in the result ("kernel was restarted after a timeout; variables
are gone"), and have the tool description state the contract: the kernel is a
scratchpad, durable state belongs on disk.

**K4 — The model writes tool calls blind inside the kernel.** `tools.read_file(path=...)`
has no schema visible from inside; a typo costs a whole round trip and a
traceback. The host holds every JSON schema.
*Fix:* inject a compact signature list into the kernel namespace at start —
`tools.help()` plus generated stubs — from the same schemas pi uses. This is
the difference between a Python API and a guess.

**K5 — Results come back as `repr()`, not as data.** The bridge returns the repr
of the last expression plus captured stdout. A program that computes a dict
returns Python syntax; a program that prints returns prose.
*Fix:* a documented convention plus a helper (`emit(obj)`) whose payload
arrives as JSON; keep repr as the fallback.

**K6 — No memoization across a program.** Reading the same config twelve times
in a loop costs twelve host calls. The host sees `(name, args)` pairs and can
dedupe within one program with a tiny cache.
*Fix:* a per-run call cache in `runBatch`, with a note in the result when a
call was served from it.

**K7 — Nothing tells the model that memory is callable from inside.** The
directive explains memory tools as tools; it does not say
`tools.memory_search(...)` works inside `ipy_run`, nor that the kernel is the
cheap way to search memory twenty times.
*Fix:* one sentence in `MEMORY_DIRECTIVE`. This is a documentation fix with an
outsized effect, because it makes the two levers compose.

**K8 — A long cell reports nothing until it finishes.** No progress events, so
a 90-second program looks like a hang; in the TUI it is a spinner on a tool
block.
*Fix:* an optional `progress()` helper in the kernel namespace that emits an
out-of-band line the host renders as tool output. Bounded, and it makes long
programs legible.

**K9 — In-kernel `ask` resolves to allow.** Documented and accepted (no
`ctx.ui` is reachable from the kernel): `deny` still blocks, plan mode still
holds, but an `ask` rule cannot prompt. Worth restating in the README's
security section so nobody discovers it by surprise.

---

## 4. Cross-cutting levers

**C1 — Verification is the missing half of autonomy.** The system writes code
and runs it; it does not, by default, *check* its work. The repo already has an
auditor pattern (three parallel read-only auditors, findings through a single
writer) used once, by hand.
*Fix:* a `verify` convention for non-trivial changes — the agent runs the
project's tests, states what it did not check, and a reviewer subagent (same
model, fresh context, the diff only) gets to disagree. Cheap because
delegation and the shared memory bus already exist.

**C2 — Context economy is unmanaged.** Tool output is capped at 1000 lines
(good), the transcript is not token-aware, compaction is implemented in pi but
not exposed by the TUI, and the recall block breaks the cache (M1).
*Fix:* expose `/compact` (pi's RPC has it), make truncation token-aware rather
than line-aware, and treat the system prompt as a frozen prefix.

**C3 — Tool surface is flat.** 14 core tools + 3 memory + MCP + bundles, all
offered always (§ P6 in the command-surface review).
*Fix:* toolsets, plus a rule that a tool must earn its place: no tool that one
tool can express, no tool whose failure mode the model cannot see.

**C4 — Delegation has no depth cap and no routing policy.** Any child can spawn
children (issue #6); model choice per child is manual.
*Fix:* a depth limit, and routing by task shape (search/extract → cheap model;
plan/verify → strong model), which is exactly what the multi-model support was
built for.

**C5 — Cost is measured, not controlled.** `on_cost_over` triggers fire into
nothing (issue #8).
*Fix:* make the trigger able to act: stop the run, or downgrade the model for
the remainder — with the decision logged.

**C6 — Observability is write-only.** Traces are recorded and readable via
`mnemo traces`, but nothing aggregates them into "this session cost this much,
took this long, failed here".
*Fix:* a local session report (`mnemo insights`-shaped but offline), and a
one-line turn summary the TUI can show.

**C7 — Autonomy exists but is not goal-directed.** Schedules fire prompts;
nothing maintains a backlog of what the project needs next.
*Fix:* let the agent write "next useful work" entries (from its own gaps,
failures and TODO markers) into a file the schedules can pick up — with the
cost guard from C5 in front of it.

---

## 5. The ceiling, honestly

- **Memory cannot fix a model that cannot plan.** Retrieval improves the
  starting state; it does not add reasoning depth. The 3/3-with-memory result
  is about *recovering facts*, which is the part memory can do.
- **Retrieval quality is bounded by what was written.** An empty journal has
  perfect precision and no recall. More knowledge ≠ better, unless the write
  path is disciplined (M8–M11).
- **Evals this size cannot resolve small differences.** n=22 with ~6 misses
  means a one-case change moves Hit@1 by 4 points. Every claim needs the
  "before/after, all rows" discipline the project already applies to B3.
- **Self-improvement has a failure mode: feedback loops.** A memory that
  rewards what it retrieves will retrieve what it rewards. M5 and M13 are the
  seams where that can happen, which is why both are specified with an
  external check (real outcomes, held-out split).

---

## 6. Order of work

| Priority | Item | Why now | Cost |
|---|---|---|---|
| P0 | M12 — memeval in CI | protects every other memory change; seconds | tiny |
| P0 | M1 — cache-safe recall | memory currently taxes every turn; pure win | small |
| P0 | K1 — per-call kernel timeout | a hang today is unbounded (issue #6) | small |
| P0 | K7 / K3 — tell the model the truth about the kernel | documentation; makes two levers compose | tiny |
| P1 | M5, M10, M14 — stop the one-sided feedback; conflict check; turn-quality signal | the substrate for learning | medium |
| P1 | K4, K5 — kernel introspection + structured results | turns generated code from guessing into programming | medium |
| P1 | M3, M4 — router decision + reranker, both gated | retrieval quality, measured | medium |
| P2 | M13, M15, M16 — real training rows, `/init`, corpus growth | learning that compounds | large |
| P2 | K2, K6, K8 — kernel limits, call cache, progress | robustness of the main lever | medium |
| P2 | C1, C2, C4, C5 — verification, context economy, delegation caps, cost control | make autonomy safe to increase | large |
| P3 | the memory runtime (`research/memory-runtime-design.md`) | acts on this list while nobody is watching | large |

### What not to build

- A second agent loop inside the memory layer (companion doc §2).
- Embedding-model self-training, or any loop where the system grades its own
  work without an external check.
- Journal GC/compaction without a human-readable dry run — the audit already
  established what an unreadable journal costs.
- More tools, until the ones that exist are legible (K4) and bounded (K1, K2).
