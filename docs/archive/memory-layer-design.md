# Memory Layer — Detailed Design
Version 1.0 · Companion to docs/system-design.md §3 · Implementation: memory-layer/ (Rust)

## 1. Node anatomy

```json
{
  "id": 2,
  "kind": "Aspect",                    // Aspect | TaskEpisode | Entity | Harness | Outcome
  "label": "ingress annotations",
  "facts": [
    { "id": 1, "key": "rewrite",
      "value": "nginx rewrite-target annotation routes paths",
      "status": "Superseded",          // Active | Superseded
      "created_at": 1700000000000,
      "superseded_by": 3 },            // history is NEVER deleted
    { "id": 3, "key": "corrected",
      "value": "v1 annotation removed in networking.k8s.io/v1",
      "status": "Active", "created_at": 1700000060000, "superseded_by": null }
  ],
  "log": [                             // append-only; "model-visible means logged"
    { "at": 1700000000000, "kind": "created",     "detail": "node created as ..." },
    { "at": 1700000002000, "kind": "fact_added",  "detail": "rewrite: ..." },
    { "at": 1700000060000, "kind": "fact_superseded", "detail": "1 -> 3: ..." }
  ],
  "context": [                         // pushed by predecessors; DERIVED store
    { "from": 5, "dim": 1024, "vec": [...], "note": "ingress ctx summary" }
  ],
  "created_at": 1700000000000,
  "deleted": false                     // tombstone; hard delete removes entirely
}
```

Invariants:
- `state` is never stored as truth. `state_of(id)` derives it from active facts +
  last-5 log entries + context-chunk notes. Deleting state loses nothing.
- Facts are superseded, never erased — steering corrections preserve history.
- Context chunks record their source (`from`) so blame can travel upstream.

## 2. Operation catalog (the journal alphabet)

| Op | Fields | Effect |
|----|--------|--------|
| CreateNode | id, kind, label, at | new node, log "created" |
| AddFact | node, fact_id, key, value, at | append fact + log |
| SupersedeFact | node, old_fact, new_key/value/fact_id, at | old→Superseded(+superseded_by), add new, log |
| DeleteNode | node, hard, at | tombstone or remove |
| Link | id, src, dst, kind, at | edge born weight=0.5 |
| Unlink | edge, at | sets invalid_at (soft kill) |
| Reweight | edge, delta, at | weight clamped [0,1] |
| RecordOutcome | edge, success, at | success:+1/+0.05 · failure:+1/−0.10 |
| PushContext | to, chunk{from,dim,vec,note}, at | append context chunk |
| CommitLog | node, kind, detail, at | raw event into node log |

Rules: every op validates referenced ids exist; replay(ops) == state exactly;
ids are monotonic counters on the store (next_node / next_edge / next_fact).

## 3. Persistence

### 3.1 Journal
Append-only JSONL, one serialized `Op` per line. Writers:
memcli, memtui, memsrv, N agents. Every writer opens `<journal>.lock`
(`fd_lock::RwLock`, exclusive) around each append ⇒ partial/corrupt lines are
impossible even across processes. Readers tolerate a torn tail by skipping bad ops.

### 3.2 Snapshots & load
`write_snapshot` serializes the whole store (atomic tmp+rename). Load =
snapshot first, then replay journal tail. Snapshot/journal equality is tested.
Clock seeding: new processes set clock = max(at in journal)+1 so ops stay ordered.

### 3.3 What is NOT journaled
Node embedding vectors, HNSW index, embed cache — all derived/reconstructible.
Embedder switches require one `reindex` pass, nothing else.

## 4. Embedding pipeline

```
text(node) = "{Kind} {label}" + active facts "{key} {value}"... + last 3 log entries
                 │
                 ▼
       Embedder trait ──► Vec<f32> (L2-normalized)
       ├─ HashingEmbedder   : token feature-hashing, DIM=256, offline, deterministic
       └─ OpenRouterEmbedder: POST /api/v1/embeddings
            model liquid/lfm-2.5-embedding-350m:free → 1024-dim
            cache key = sha256(model ‖ \0 ‖ text) → data/embed-cache.json
            retry/backoff on 429/503 (1.5s·2^n, 4 tries); failure → empty vector
```

Selection: OPENROUTER_API_KEY present (env or .env) ⇒ remote; else hashing.
Override flag --embedder. Because vectors are derived, model swap costs one reindex.

## 5. Retrieval algorithm

Stage 1 — seeds: cosine(query_vec, node_vec) over live non-deleted nodes
(brute force exact under ~100k nodes; HNSW index via hnsw_rs above that —
`search_ann` same contract). Filter score > 1e-6, sort desc, take k.

Stage 2 — graph expansion: for each seed s with score q, for each ALIVE edge
(kinds PartOf, SuppliesContext, ActivatedWith, DerivedFrom) touching s:

    neighbor_score = max(current, q × 0.5 × max(edge.weight, 0.1))

Dead edges (invalid_at set or weight 0) propagate NOTHING. Type filter applies
to both stages. Output: top-k SearchResult{node, score, via_graph}.

Measured (15 queries, 12-node graph): hashing Hit@1 53% vs OpenRouter 80%.

## 6. Steering specification

Planner is PURE: steer(store, episode, failure_detail, correction?, now)
→ (Vec<Op>, SteerNotes). Applying + journalling stays with the caller ⇒
steered histories replay exactly.

| Rule | Condition | Action |
|------|-----------|--------|
| R1 log | always | CommitLog(kind="outcome") on episode |
| R2 blame | lexical_overlap(failure tokens, feeder facts) > 0 OR correction targets its node | RecordOutcome(failure) on that feeder edge |
| R3 correction | correction given, fact must be Active | SupersedeFact(old → new) |
| R4 switch | projected weight after penalty < 0.20 AND another live feeder > 0.20 exists | Unlink(bad edge) + Link(alternate → episode) |
| R5 gap | no feeder implicated AND no correction | CreateNode("gap: <tokens>") + fact("missing_knowledge") + link as context source |
| R6 reinforce | reinforce() on success | RecordOutcome(success) on ALL live feeders |

Constants: BLAME_PENALTY −0.10, SWITCH_THRESHOLD 0.20, success nudge +0.05.
SteerNotes returned for UI/agent consumption: blamed_feeders, superseded_on,
gap_node, switched_from, unblamed_feeders.
Validation errors: target not TaskEpisode; correction fact missing/inactive.

Worked example (demo.rs): ingress feeder blamed 0.5→0.4, stale v1 annotation
fact superseded, limits feeder untouched, all journaled, replay-exact.

## 7. Public API surface

Library (crate): StoreData::{apply, state_of, feeders_of}, Journal::{open,append,
read_all}, persist::{replay,write_snapshot,load}, search/{build_vectors,search,
search_ann}, steering/{steer,reinforce}, vec::{HashingEmbedder, cosine},
remote::OpenRouterEmbedder.

memsrv JSON-RPC (line per request/response):

| Method | Params | Result |
|--------|--------|--------|
| ping | — | {pong:true} |
| dump | — | {nodes:[{id,kind,label,facts,feeders}]} |
| state | node | {state:"derived text"} |
| search | query, k? | {results:[{node,score,via_graph}]} |
| create_node | kind?, label | {node} |
| episode | label | {episode} |
| fact | node, key, value | {fact} |
| link | src, dst | {edge} |
| commit_log | node, kind, detail | {logged:true} |
| steer | episode, failure, fix?{node,fact,new_key,new_value} | notes object |
| good | episode, detail | {reinforced:true} |
| exit | — | server exits |

## 8. Failure modes & mitigations

| Risk | Mitigation |
|------|------------|
| Concurrent writers interleave lines | fd-lock exclusive per append (tested: 4×25 parallel appends) |
| Crash mid-append | readers skip unparseable tail ops; lock prevents torn writes |
| Embedding API down / rate-limited | backoff retries; degrade to empty vector (scored low, never crashes) |
| Corrupt journal op | apply() error surfaced; memsrv skips and warns |
| Orphaned processes holding locks | advisory lock dies with fd — OS releases automatically |
| Embedder switch breaks recall | vectors derived → reindex; cache keyed by model name |

## 9. Test coverage map
p0: lifecycle, supersede+decay-to-death, journal/snapshot exactness.
P1: embedder determinism/normalization, relevance ranking, cluster expansion,
dead-edge stop, type filter, superseded-fact leaves embeddings, HNSW≈brute.
P2: blame isolation, correction supersede, gap creation, edge switch, reinforce,
rejections, steered-journal exactness.
Integration: 100 concurrent appends verbatim; full RPC roundtrip incl. steer.
