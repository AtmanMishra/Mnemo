# Memory Layer Improvements — curated, no-bloat edition

*Status: design proposal for AREA 11 (plan.md). Companion: docs/MEMORY.md,
research/brain-areas-design.md. NOT yet planned for implementation.*

## 0. Guardrail (the point of this whole document)

The memory layer has ONE job: a graph store that (a) persists facts with a
history, (b) retrieves the **right context** when asked, and (c) reshapes
itself (steering, consolidation) so it improves with use. That's it. Every
proposal below must serve one of those, or be deferred. The alternative — a
vector-DB-plus-ML-pipeline with a feedback engine, cluster summarizers, recency
decay, learning-to-rank, journal GC and async reads — buries the graph model
under plumbing. We are not doing that here.

**The evaluative tripwire:** every change that touches retrieval MUST keep
`memeval --hash` at **Hit@1 ≥ 73% / Hit@3 ≥ 77% / MRR ≥ 0.743 (n=22)** or
improve it. This is the same two-gate rule B3 established for alias entries,
generalized to all retrieval work. If a change drops it, revert. This is how we
know we didn't screw up the job.

## ML-1 — Caching (THE missing piece)  [do first]

The hot path recomputes things it doesn't need to. Embeddings are already
disk-cached (text-hash → vector per model — leave that alone). What is NOT
cached:

1. **Search results.** Every `memsrv search` re-runs routing → HNSW traverse →
   scoring → ranking, and it's called on **every agent turn** (recall) and on
   every TUI memory-pane query. On a large graph this is the inner loop.
   *Fix:* a small **in-memory LRU** in the memsrv store, keyed by `(normalized
   query, areas[], k)`, bounded (e.g. 256 entries, or a byte budget). Evict LRU.
   *Ceil:* an LRU `Map` + an `Array` order list. No TTL yet, no shared cache, no
   Redis.
   *Add when:* stale reads show up (a query re-run after the graph changed
   returns the old answer) → then add a per-key invalidation on the journal ops
   that touch matching nodes, or a short TTL. The bound (size) is what matters,
   not correctness under mutation — a memory layer is a cache of its own facts
   anyway.

2. **Node state.** `state_of(node)` derives from active facts + last-5 log
   entries + context chunks, and recomputes on every `state()`/`dump()` call —
   the TUI memory pane calls it a lot. It's pure recompute.
   *Fix:* memoize `state_of` per node; invalidate on any journal op that touches
   that node. One `HashMap<NodeId, Mutex<Snapshot>>` in the store.
   *Ceil:* simple memo, invalidation on write. Not a time-based cache.

**Why this is the right first step:** it's the only proposal that is pure
performance — zero semantic change, high payoff on the exact path the product
lives on, and it can't make retrieval worse (worst case it's a no-op if the LRU
misses). Do ML-1 in isolation, measure `memeval --hash` unchanged, ship.

## ML-2 — Retrieve-usefulness feedback, routed through EXISTING machinery

The memory layer *already* reweights by failure/success (edge counters + steer).
What it lacks is a **user/agent usefulness signal** feeding that. This is
on-design, not new machinery.

- Capture a signal when a recall is actually used: the agent's recall hook marks
  the nodes it pulled into context as `useful`; the TUI memory pane gets a
  thumbs-up/down on a hit.
- Route it into the existing `prefer()` / edge success-failure counters, so the
  edges that keep being *useful* get weight, and ones that return noise get
  down-weighted — exactly how steer treats a failing feeder.
- *Ceil:* a `useful`/`unhelpful` integer on the node/edge, incremented, and at
  most a small "bias" added to the retrieval score. Two counters, one multiplier.
- *Add when:* the counters accumulate enough to matter → then feed them to
  mempolicy (which already knows how to learn a scoring rule) and let the
  learned weight replace the fixed one. Do NOT build a learning-to-rank system
  now; mempolicy stays an experiment until a journal has signal.

## ML-3 — Integration-surface niceties (thin wrappers, no new engine)

The memsrv protocol is low-level (create_node, fact, link, steer…). The agent
and TUI have to compose them. Two thin helpers make the surface cleaner and are
cheap because they sit on existing ops:

- `recall_brief(query)` → returns a **ready-to-inject memory block**: routed
  areas, top-k hits with State text inlined (never bare scores — HANDOFF §6.6),
  and a one-line provenance ("recalled k nodes from areas a,b; newest changed
  K—when"). The agent can paste this into context directly.
- `remember(summary)` → auto-routes a plain-language summary to the right area
  (reuse the existing `route_query`/`Area::for_kind` heuristic), creates the
  node + facts + a log entry in one call. `memory_write_fact` improves without
  the caller needing to know the area mapping.

*Ceil:* a function in memsrv that composes existing calls. No new graph model,
no new storage. *Add when:* if these prove rarely used, remove them — they are
costless to delete.

## Explicit NON-GOALS (defer — one-line "why" so we don't bloat)

| Idea | Why deferred |
| --- | --- |
| Learned embedding/query-router ML pipeline | mempolicy has no journal signal yet; a classifier you can't train is dead weight — ship only when the journal accrues real failures |
| Per-kind recency-decay tables | `Supersede` already handles factual staleness; add only if stale-but-active facts *measurably* rank wrong (the P2 family), not on speculation |
| Cluster-level retrieval + centroid summaries | PartOf clusters are young & small today; add when clusters get big enough to need a summary |
| Proactive `ActivatedWith` neighbor recall | Speculative benefit; edge co-retrieval is real but don't build a recommender into core retrieval |
| Journal snapshot/GC/compaction | Add only when the journal measurably grows past comfort; there's a real threshold, not a design exercise |
| Parallel/async memsrv reads | Only under measured serialization pain; the FIFO client is fine at current volume |
| `diff`/`timeline` debugging ops | Audit utility, not the memory layer's job; keep in the tracer, not the graph |

## Verification discipline (per change)

- Deterministic tests: real `memsrv` over a **temp journal**, fake pi where the
  agent is involved, `setProjectRoot()`/`setSkillsHome()` overrides where skill
  discovery is touched. No live LLM. Run both before and after.
- `memeval --hash` pinned: **73% / 77% / 0.743** must hold or improve for ANY
  retrieval-adjacent change (ML-2, ML-3, and any ML-1 invalidation). ML-1 alone
  should be byte-identical (it's a transparent cache).
- `cargo test` green; `npm test` in `agent/` green if the agent recall path
  changed (watch for the npm hang patterns — HANDOFF §6).
- Commit each change; message says WHY.

## Order

1. **ML-1 caching** (both halves) — isolated, no semantic risk, measure unchanged.
2. **ML-3 thin wrappers** (`recall_brief`, `remember`) — small, clean surface.
3. **ML-2 feedback** — the only behavioral change; strictly behind the memeval
   no-regression gate. Milestone: measure that useful-edges bias improves recall
   on a small crafted corpus OR stays neutral; if neutral, keep the counters and
   defer routing to mempolicy.
