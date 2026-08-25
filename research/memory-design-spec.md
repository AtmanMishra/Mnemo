# Memory Layer — Design Spec v0.1
Status: DESIGN. No implementation yet. Builds on memory-layer-notes.md (research).
All major open questions resolved; remaining defaults marked [DEFAULT].

## 0. Confirmed decisions
- Node = { facts, state, log, context }. state is DERIVED (facts + log tail), never edited directly.
- Domains are CLUSTERS of fine-grained aspect-nodes, not single nodes.
- Edges are live: created / deleted / switched as work succeeds or fails (steering).
- Multiple node types; typed edges between them.
- Context flows predecessor -> successor; sending correct context is the predecessor's obligation.
- Context stored as vectors (HNSW); facts as structured text (+ optional per-fact vector); log append-only.
- Rust sidecar service; pi extension wraps it as AgentTools.

## 1. Node types (v1 set)
| Type | Remembering | Example |
|---|---|---|
| aspect | one facet of a skill/domain | "helm rollback quirks", "nginx ingress annotations" |
| task-episode | one work session/outcome | "migrated CI to actions, failed on secrets" |
| entity | a concrete thing | repo, service, file path, tool version |
| harness | a generated plugin/skill | "k8s-debug-harness v3", its tools + validity |
| outcome | result record of applying knowledge | "that fix worked / regressed" |

## 2. Edge types
| Edge | Meaning |
|---|---|
| supplies-context | A -> B: A owes B context (the push contract) |
| part-of | aspect -> domain cluster membership |
| derived-from | episode/outcome cites the aspects it used |
| supersedes | new fact/node replaces an old one (temporal) |
| activated-with | co-retrieval association (Hebbian weight) |

Every edge carries: weight (0..1, decayed over time), temporal validity
(valid_from / invalid_at, Graphiti-style), and last_outcome (success/failure tally).

## 3. Core API surface (sidecar)
    create_node(type, facts[], initial_context?) -> id
    update_node(id, add_facts?, supersede_fact?(old,new))   # state recomputes
    delete_node(id, mode=tombstone|hard)
    get_state(id)                 # cheap derived snapshot for the agent
    search(query_vec|text, k, type_filter?) -> ranked nodes via HNSW + edge propagation
    link(src, dst, type) / unlink(edge_id) / reweight(edge_id, delta)
    steer(failed_episode_id)      # the interesting one, see §4
    commit_log(node_id, entry)    # "model-visible means logged"
    snapshot() / replay(log)      # persistence

## 4. Steering algorithm v0 (rule-based [DEFAULT])
Trigger: an outcome-node records failure attributed to episode E.
1. Mark all nodes/edges E's context came from as involved.
2. Down-weight `supplies-context` edges into E by failure signal.
3. If a specific FACT is implicated (contradicted by new evidence): supersede it;
   notify its node to re-derive state; request upstream resend of context.
4. Switching: if alternate predecessor exists with better track record,
   rewire `supplies-context` to it (edge switch, not just weight change).
5. Else create a NEW aspect-node capturing the gap ("we lacked X knowledge"),
   link it into the cluster, mark it as the context source going forward.
6. Success path: Hebbian reinforce involved edges; decay others in cluster.

## 5. Storage & indexing [DEFAULT]
- Append-only JSONL journal (one file per shard) + periodic compacted snapshots.
- Vectors: f32 -> i8 scalar-quantized, HNSW index (hnsw_rs or usearch crate).
- Embeddings: small local model first (fast iteration, private) [DEFAULT];
  interface abstracted so API embeddings can slot in later.
- Language: Rust; served over stdio JSON-RPC (mirrors dsh SDK pattern).

## 6. Integration (pi extension)
Tools registered through pi.registerTool(): memory_search, memory_write,
memory_steer, harness_create. Loader-tool pattern keeps prompt cost near zero
until memory is actually needed. Steering results can be emitted as pi followUps.

## 7. Evaluation plan (Q8)
Replay prior agent sessions as episodes; measure next-task success rate and
context-token cost WITH vs WITHOUT the memory layer; plus steering unit tests:
inject a stale fact, cause failure, assert supersede + rewire happened.

## 8. Build order (proposal, NOT started)
P0: schema types + journal + snapshot/replay (no vectors yet)
P1: HNSW context store + search()
P2: steering rules v0 + edge lifecycle
P3: pi extension + loader-tool wiring
P4: eval harness on replays
