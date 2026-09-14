# Memory Layer Research Notes
Status: RESEARCH ONLY — nothing built yet.
Companion docs: pi-agent-report.md (subagent), deepseek-harness-and-scrapling-report.md (subagent)

## 1. The proposed model, restated

A graph-based memory for a coding agent, inspired by human neural systems.

- **Node** = four things (confirmed by user):
  - `facts`  — declarative truths the node asserts (e.g., "repo uses pnpm",
    "auth middleware lives in src/auth/"). Structured, key-addressable.
  - `state`  — the node's current condition/working summary derived from its
    facts + activity. Mutable snapshot.
  - `log`    — append-only history of what happened at/to this node.
  - `context`— supplied by PREDECESSORS. It is the predecessors' job to send correct context.
- **Edges** connect nodes; context flows predecessor -> successor.
- Full lifecycle: create / delete / modify nodes and edges.
- **Steering**: when something is not working, the system (or agent) steers — rewires,
  re-weights, or redirects context flow.
- Storage constraint: raw text for state/log/context does NOT scale. Context is stored
  as VECTORS; retrieval uses algorithmic math (similarity/ANN search), not string match.

### The genuinely novel part
Most existing memory systems are PULL-BASED: store everything, retrieve by query at
read time. Your model is PUSH-BASED: each node's context is an *obligation* placed on
its predecessors — they must compress/select and send only relevant context forward.
This is closer to how cortical columns / predictive-processing chains work than to a
database. It also creates a natural credit-assignment signal: if a node fails, its
predecessors sent bad context, so steering = punishing/updating the upstream senders.

## 2. Neuroscience grounding (which parts map to what)

| Brain mechanism | Mapping to our design |
|---|---|
| Hippocampal indexing theory | Store content in one place ("neocortex"), keep sparse INDEX pointers in the graph ("hippocampus"). Node = index entry; vector = compressed content pointer. |
| Hebbian learning ("fire together wire together") | Edge weights increase when two nodes' contexts co-retrieve successfully; decay otherwise. Steering = Hebbian update + pruning. |
| Synaptic consolidation | Logs are append-only (journal); state/context are periodically consolidated (re-embedded, summarized) like sleep replay. |
| Complementary learning systems | Fast episodic store (log, exact) vs slow semantic store (state, vector). Two timescales in one node. |
| Attractors / Hopfield nets | Retrieval can be iterative: query vector -> nearest node -> pull its predecessors' vectors -> refine query. Converges to an "attractor" = recalled episode. |

## 3. Prior art surveyed

- **HippoRAG** (arxiv 2405.14831): LLM + knowledge graph + Personalized PageRank,
  modeled on hippocampal indexing theory. Up to +20% on multi-hop QA, 6-13x faster
  than iterative RAG. Lesson for us: graph propagation over a memory graph beats
  flat vector search for multi-hop recall — supports keeping the graph structure.
- **A-MEM / Agentic Memory** (arxiv 2502.12110): Zettelkasten-style dynamic memory.
  New memories generate structured notes (context description, keywords, tags), then
  the system links them to historical memories AND EVOLVES old memories when new ones
  arrive. Closest existing work to our create/link/modify/steer lifecycle.
- **Graphiti/Zep** (getzep/graphiti, arxiv 2501.13956): temporal context graphs;
  facts change over time, provenance tracked, incremental updates without full
  recomputation. Lesson: temporal validity on edges matters (an edge that was true
  yesterday may be invalid today — relevant to our steering).
- **Letta/MemGPT**: OS-style paging of context into an LLM window. Lesson: the
  consumer of context has a finite window; predecessor nodes must COMPRESS, which
  matches our "predecessor sends correct context" contract.
- **Modern Hopfield networks** (Ramsauer et al., "Hopfield Networks is All You Need",
  arxiv 2008.02223): attention IS a Hopfield update; associative retrieval over
  stored patterns converges in one step with exponentially large capacity.
  Mathematical basis for our iterative vector recall.
- **memoripy-style associative stores**: activation values + decay + reinforcement on
  access. Simple precedent for per-node activation scoring.

## 4. Vector storage: what "algorithmic math" concretely means

Options, cheapest first:

1. **Brute-force cosine over f32 arrays** — fine up to ~100k nodes; trivial in Rust.
2. **HNSW (Hierarchical Navigable Small World)** — the standard ANN index; O(log n)
   search. Rust crates exist (`hnsw_rs`, `usearch`, `instant-distance`). Graph-in-graph:
   our memory graph sits above an HNSW index over node context vectors.
3. **Quantization**: f32 -> i8 scalar quantization or product quantization cuts memory
   4-16x with small recall loss. Worth doing since EVERY node carries a context vector.
4. **Binary signatures / LSH**: cheap pre-filter stage before exact rerank.

Embedding source decision (open question Q4 below): local model vs API embeddings vs
learned-from-use. For a coding agent, code-aware embeddings (e.g., a small local
embedding model) matter because context will contain tool schemas, diffs, stack traces.

## 5. Lifecycle & steering semantics (to be pinned down)

- CREATE(node): embed initial context (from predecessors at birth), empty log, initial state.
- MODIFY(node/state): version it? A-MEM shows old memories should evolve when new info
  arrives — propose: state updates in place, but log records the delta (log = journal).
- DELETE(node): soft-delete (tombstone + vector removal) vs hard delete. Predecessors
  must be notified — their outgoing-context obligation changes.
- EDGE ops: create/delete/REWEIGHT. Weight = reliability of the context that flows.
- STEERING triggers (hypotheses):
  - Task failure attributed to node N => lower weights on incoming edges of N,
    ask predecessors to resend different context (a "retry upstream" primitive).
  - Repeated successful retrieval => reinforce (Hebbian).
  - Time decay on edge weight; steering can freeze/pin important edges.
- OPEN: who steers? The agent via tools (explicit) vs automatic rules inside the
  memory engine (implicit)? Probably both: cheap rules implicit, big rewires explicit.

## 6. Why Rust (honest answer to "because fast? idk")

Speed is real (ANN search, zero-GC latency, SIMD-friendly array math) but it is NOT
the main reason. Better reasons:
1. **Embeddable library**: build once as a native lib, expose to Python via PyO3/maturin
   — the pi-agent side stays Python, memory layer ships as a wheel. No service to run.
2. **No GC pauses**: memory workloads hold hundreds of MB of vectors; GC pauses hurt
   interactive agents more than throughput benchmarks show.
3. **Safe concurrency**: multiple agent sessions reading/writing one memory graph.
4. **Ecosystem fit**: hnsw_rs/usearch, sled/redb (embedded storage), rayon (parallel
   consolidation) are mature.
Counterpoint worth recording: if the team iterates fast on the DESIGN (we are — this
is research), a Python prototype validates semantics 3-5x faster, then port hot paths.
Proposal: design the schema/semantics now, decide language after the pi-agent +
harness reports land (the plugin system may dictate the boundary anyway).

## 7. Open questions to settle BEFORE building

Q1. RESOLVED by user:
    - A domain (e.g. kubernetes-deploy) is NOT one node. It is a CLUSTER of
      fine-grained nodes, each remembering one ASPECT of the domain.
    - During project work, failures/issues ACTIVATE the relevant nodes; edges
      between them get created, deleted, or SWITCHED in response; nodes update
      constantly. The graph is live, not batch-built.
    - Multiple node TYPES exist ("nodes to remember stuffs"): e.g. skill-aspect,
      task-episode, project-entity, harness/plugin nodes.
    - Steering therefore has a concrete mechanism: failure => touch the involved
      aspect-cluster => rewire its internal edges + upstream context edges.
Q2. Context dimensionality & format: fixed-dim embedding of what exactly — the
    predecessor's state? its recent log tail? a learned mixture?
Q3. Who computes embeddings: local model (offline, private, slower) vs API?
Q4. Is `state` also vectorized, or kept symbolic/text with only `context` vectorized?
    (User's instinct: only context needs vectors; state may stay compact text.)
Q5. Persistence: embedded KV store (redb/sled) vs plain files (append-only log +
    snapshot) vs SQLite. Research phase suggests files-first for debuggability.
Q6. Steering policy: rule thresholds first, learned later?
Q7. Integration surface: how does the future coding agent call this?
    RESOLVED IN PART by pi-agent-report.md: pi is TypeScript, so a Rust memory layer
    cannot be PyO3-embedded as originally sketched. Realistic options:
      a) NAPI-RS native addon — Rust compiled into the TS process; fastest calls,
         but crashes take the agent down and rebuilds per-platform are friction.
      b) Sidecar service (HTTP/gRPC/Unix socket) — Rust process owns the graph +
         ANN index; pi talks via an extension that wraps `pi.registerTool()`.
         Cleanest isolation; memory survives agent restarts.
      c) MCP server — same as (b) with a standard protocol any agent can use.
    Lean: (b)/(c). The pi extension would expose memory ops AS TOOLS
    (memory_search, memory_write, memory_steer), fitting pi's data-like AgentTool
    model and its deferred tool loading.
    Bonus alignment: pi already has steering/followUp queues in its loop — our
    graph-level steering can emit followUps into them.
Q8. Evaluation: how do we MEASURE memory quality before building much? Candidate:
    replay past agent sessions, measure next-task success with/without memory.

## 8. Sources
- https://arxiv.org/abs/2405.14831 (HippoRAG)
- https://arxiv.org/abs/2502.12110 (A-MEM)
- https://github.com/getzep/graphiti + https://arxiv.org/abs/2501.13956 (Zep paper)
- https://arxiv.org/abs/2008.02223 (Hopfield Networks is All You Need)
- https://github.com/earendil-works/pi (see pi-agent-report.md)
- https://deepseek-harness.github.io/deepseek-harness/en/guide/python-sdk (see harness report)

## 9. Three-way synthesis (all research streams complete)

Sources: memory-layer-notes.md (this doc), pi-agent-report.md,
deepseek-harness-and-scrapling-report.md.

### Architecture that emerges

    +----------------------------------------------+
    |  Coding agent built on pi (TypeScript)       |
    |  - pi extension exposes OUR tools:           |
    |      memory_search / memory_write /          |
    |      memory_steer / harness_create           |
    |  - dynamic harness/plugin creation uses      |
    |    pi.registerTool() at runtime (proven OK)  |
    +--------------------+-------------------------+
                         | JSON-RPC over stdio or HTTP
                         v
    +----------------------------------------------+
    |  Rust MEMORY LAYER (sidecar service)         |
    |  - graph of nodes {facts, state, log,        |
    |    context-vectors}                          |
    |  - HNSW index over context vectors           |
    |  - steering engine (edge reweight, fact      |
    |    supersede, upstream resend requests)      |
    +----------------------------------------------+

### Patterns adopted from each source

From **pi**:
- Tools are plain schema'd data -> our memory ops ship as normal AgentTools;
  lazy activation via loader-tool pattern means the agent pulls memory skills
  only when relevant (cheap prompt).
- pi's steering/followUp queues are where graph-level steering decisions get
  delivered to the live loop.
- Session JSONL trees = raw material the memory layer ingests (task episodes).

From **deepseek-harness**:
- Definition/provider/consumer seam + effect-based registration (dispose =
  unregister): adopt for harness-plugin lifecycle; mirrors node create/delete
  obligations in our graph (delete a node => predecessors notified).
- Watched skill directories with write-invalidated catalogs: simplest viable
  self-extension channel; new skills written mid-session become loadable
  immediately. Our `facts` can index these catalogs per domain.
- Per-scope registry layers / agent presets: how different subagents see
  different slices of the memory graph without process isolation.
- INVARIANT WORTH ADOPTING: "model-visible means logged" -- anything that
  reaches the model's context must appear in some node's log. Directly
  strengthens our push-based context contract: if you send context, you log it.

From **Scrapling** (capability, not architecture):
- Verified working stack for future research subagents:
  Fetcher (static/TLS-impersonation) -> DynamicFetcher (JS SPA) ->
  StealthyFetcher (anti-bot). Session classes for stateful crawls,
  response.markdown() for LLM-ready ingestion into memory nodes.
- Examples kept at research/scrapling-examples/{01,02,03}_*.py,
  venv at research/scrapling-venv.

### How the four-component node serves this architecture
- facts: index skills/catalogs/projects ("kubernetes-deploy exists at X",
  "this repo fails lint without Y"). Facts give steering a precise target:
  supersede a stale FACT rather than vaguely rewiring an edge.
- state: derived snapshot an agent reads cheaply before acting in a domain.
- log: satisfies the "model-visible means logged" invariant; also the
  training signal for future learned steering policies.
- context: vectors pushed by predecessors; HNSW-indexed; the retrieval path.

### Remaining open questions (narrowed)
Q1-residual: node types & creation policy -> proposal: typed nodes
   (skill-node, task-node, entity-node, harness-node); new fact about an
   existing entity updates that node instead of creating one.
Q2: RESOLVED — state is always derived (rebuildable from facts + log tail). User confirmed.
Q3/Q4 embedding source; Q5 persistence (files-first proposed);
Q6 steering thresholds first; Q8 eval via session-replay benchmarks.
