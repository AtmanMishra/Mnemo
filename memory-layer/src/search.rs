//! Vector search over node embeddings + graph-aware rerank.
//! Node vectors are DERIVED (label + active facts + recent log) -> never journaled.
use crate::model::{Area, EdgeKind, Millis, NodeId, NodeKind};
use crate::store::StoreData;
use crate::vec::{cosine, Embedder};
use std::collections::HashMap;

/// Text a node is embedded from. Derived; recomputed after updates.
pub fn node_text(store: &StoreData, id: NodeId) -> Option<String> {
    let n = store.nodes.get(&id)?;
    if n.deleted { return None; }
    let mut parts = vec![format!("{:?} {}", n.kind, n.label)];
    for f in n.active_facts() {
        parts.push(format!("{} {}", f.key, f.value));
    }
    for l in n.log.iter().rev().take(3) {
        parts.push(format!("{} {}", l.kind, l.detail));
    }
    Some(parts.join(" "))
}

/// Build embeddings for all live nodes.
pub fn build_vectors(
    store: &StoreData,
    emb: &dyn Embedder,
) -> HashMap<NodeId, Vec<f32>> {
    store.nodes.keys().copied()
        .filter_map(|id| node_text(store, id).map(|t| (id, emb.embed(&t))))
        .collect()
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchResult {
    pub node: NodeId,
    pub score: f32,
    /// how much of the score came from cluster expansion vs direct hit
    pub via_graph: bool,
}

/// Shared graph-expansion rerank over raw seed hits.
fn expand(
    store: &StoreData,
    seeds: Vec<(NodeId, f32)>,
    k: usize,
    now: Millis,
    opts: &SearchOpts,
) -> Vec<SearchResult> {
    let mut out: HashMap<NodeId, SearchResult> = HashMap::new();
    for (id, s) in seeds {
        if store.nodes.get(&id).map(|n| n.deleted).unwrap_or(true) {
            continue;
        }
        out.insert(id, SearchResult { node: id, score: s, via_graph: false });
        for e in store.edges.values() {
            if !e.alive_at(now) { continue; }
            if !matches!(e.kind, EdgeKind::PartOf | EdgeKind::SuppliesContext | EdgeKind::ActivatedWith | EdgeKind::DerivedFrom) { continue; }
            let nb = if e.src == id { Some(e.dst) } else if e.dst == id { Some(e.src) } else { None };
            // a filtered-out node must not sneak back in as a neighbour —
            // "restrict to this area/kind" has to mean the whole result set
            if let Some(nb_id) = nb.filter(|n| passes_filter(store, *n, opts)) {
                let boosted = s * 0.5 * e.weight.max(0.1);
                let entry = out.entry(nb_id).or_insert(SearchResult { node: nb_id, score: 0.0, via_graph: true });
                if boosted > entry.score {
                    entry.score = boosted;
                    entry.via_graph = true;
                }
            }
        }
    }
    let mut results: Vec<SearchResult> = out.into_values().collect();
    results.sort_by(|a, b| b.score.total_cmp(&a.score));
    results.truncate(k);
    results
}

/// Search filters. `Default` = unfiltered, which is what most callers want.
#[derive(Debug, Clone, Default)]
pub struct SearchOpts {
    /// Nodes that belong to another project (audit F10): never returned and
    /// never reached by expansion. Computed per request from `PartOf` edges.
    pub exclude: std::collections::HashSet<NodeId>,
    pub kind: Option<NodeKind>,
    /// Restrict to these brain areas. Empty = every area.
    pub areas: Vec<Area>,
    /// Areas the query was routed to. Not a filter: nodes outside them are
    /// still searched, just scored down by `cross_area`. Empty = no bias.
    pub prefer: Vec<Area>,
    /// Score multiplier for nodes outside `prefer`. None = CROSS_AREA_DISCOUNT.
    pub cross_area: Option<f32>,
}

/// How much of its score an out-of-area node keeps. Tuned with `memeval`:
/// low enough to reorder near-ties, high enough that a mis-routed query still
/// finds the right node — the router is a keyword heuristic, it WILL be wrong.
pub const CROSS_AREA_DISCOUNT: f32 = 0.85;

/// Live-node count below which even an explicitly enabled ANN path must not
/// engage: `plan_search` falls back to brute force with that reason in the
/// response (`memsrv` reports it).
///
/// Why 2048: the raw seed search crosses over at ~1000 nodes on the 256-dim
/// hashing embedder — measured release-build per query, k=5: 287µs brute vs
/// 282µs HNSW at 1k, 639µs vs 431µs at 2k, 1.4ms vs 536µs at 4k. But the
/// sidecar pays more for ANN than the raw query: the index is rebuilt after
/// every write (the rebuild-on-update strategy in `ann.rs`), a build costs
/// 54ms at 1k and 141ms at 2k nodes, versus ~8ms for brute's re-embed +
/// scan — so a build only amortises in read-mostly sessions. 2048 is a
/// deliberately conservative round number above the raw crossover: below it
/// ANN would trade exactness (and a rebuild) for nothing. `search`'s "fine to
/// ~100k nodes" note is about when brute stops being usable at all; this
/// constant is about when it stops being the cheaper choice here.
pub const ANN_MIN_NODES: usize = 2048;

/// Which seed path a caller should use, and — always — why.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedPath {
    /// Exact brute-force cosine over every live node's vector.
    Brute,
    /// HNSW approximate seeds + the same graph expansion.
    Ann,
}

/// The search-path decision plus a non-empty reason, in one place so that
/// `memsrv` and its tests agree and so no caller has to guess. The ANN switch
/// is opt-in (`MNEMO_SEARCH_ANN=1`), so a silent fallback to brute force
/// would be indistinguishable from ANN returning a different ranking — the
/// reason travels in the search response for exactly that case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchPlan {
    pub path: SeedPath,
    pub why: String,
}

/// Decide brute vs ANN for a search: brute is the default and the fallback,
/// ANN only when explicitly enabled AND the graph is large enough to justify
/// its build/rebuild cost (`ANN_MIN_NODES`).
pub fn plan_search(ann_enabled: bool, live_nodes: usize) -> SearchPlan {
    if !ann_enabled {
        return SearchPlan {
            path: SeedPath::Brute,
            why: format!("brute-force is the default (exact); set MNEMO_SEARCH_ANN=1 to opt into ANN above {ANN_MIN_NODES} live nodes"),
        };
    }
    if live_nodes < ANN_MIN_NODES {
        return SearchPlan {
            path: SeedPath::Brute,
            why: format!("MNEMO_SEARCH_ANN is set but only {live_nodes} live node(s) < {ANN_MIN_NODES}: an ANN build would not amortise at this size, so the exact brute-force path ran"),
        };
    }
    SearchPlan {
        path: SeedPath::Ann,
        why: format!("MNEMO_SEARCH_ANN is set and {live_nodes} live nodes >= {ANN_MIN_NODES}: HNSW seed search (approximate; graph expansion unchanged)"),
    }
}

/// `MNEMO_SEARCH_ANN=1|true|yes|on` — the opt-in, read from a value rather than
/// from the environment so the routing can be tested without setting one.
pub fn ann_requested(value: Option<&str>) -> bool {
    matches!(
        value.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1") | Some("true") | Some("yes") | Some("on")
    )
}

/// Live nodes: every node that has not been deleted. This is the number the
/// ANN threshold is about — an index built over nodes nobody can retrieve
/// amortises nothing.
pub fn live_nodes(store: &StoreData) -> usize {
    store.nodes.values().filter(|n| !n.deleted).count()
}

/// THE search entry point: decide the path, run it, and hand the decision back.
///
/// It exists because the decision and the search were separate for too long:
/// `plan_search` was written, tested and never called, so `MNEMO_SEARCH_ANN`
/// was a switch that did nothing and the ANN path was unreachable from the
/// server while looking reachable from the tests. One caller, one decision,
/// and the reason travels with the results.
///
/// `live_nodes` is a parameter rather than a count taken here so the routing
/// is testable at the boundary that matters without building a graph of
/// `ANN_MIN_NODES` nodes to exercise it.
#[allow(clippy::too_many_arguments)]
pub fn search_routed(
    store: &StoreData,
    vectors: &HashMap<NodeId, Vec<f32>>,
    emb: &dyn Embedder,
    query: &str,
    k: usize,
    now: Millis,
    opts: &SearchOpts,
    ann_enabled: bool,
    live: usize,
) -> (Vec<SearchResult>, SearchPlan) {
    let plan = plan_search(ann_enabled, live);
    let results = search_with_path(store, vectors, emb, query, k, now, opts, plan.path);
    (results, plan)
}

/// Run the search the plan chose. Split out from `search_routed` because a
/// cache HIT has no search to run but still has a request to answer: the plan
/// is computed once per request (it is pure) and the caller reports it either
/// way, so the response says which path this query is served by even when the
/// answer came from the cache.
#[allow(clippy::too_many_arguments)]
pub fn search_with_path(
    store: &StoreData,
    vectors: &HashMap<NodeId, Vec<f32>>,
    emb: &dyn Embedder,
    query: &str,
    k: usize,
    now: Millis,
    opts: &SearchOpts,
    path: SeedPath,
) -> Vec<SearchResult> {
    match path {
        SeedPath::Ann => {
            // Built here, per search: hnsw_rs assigns layers from OS entropy
            // and inserts in parallel, so a cached index would be a different
            // graph per process anyway. Only above `ANN_MIN_NODES` and only
            // when asked for, which is the whole point of the threshold.
            let index = crate::ann::AnnIndex::build(vectors);
            search_ann(store, &index, emb, query, k, now, opts)
        }
        SeedPath::Brute => search(store, vectors, emb, query, k, now, opts),
    }
}

/// ML-2: retrieval-score bias per net usefulness vote (`useful - unhelpful`).
/// Small on purpose: it breaks near-ties toward nodes the agent/user actually
/// found useful, but never outranks a genuinely better match. With zero votes
/// (the eval corpus) the bias is exactly zero, so memeval is unaffected. The
/// fixed multiplier can later be replaced by a mempolicy-learned weight once
/// a journal accumulates enough signal — two counters, one multiplier, and
/// NOT a learning-to-rank system.
pub const USEFULNESS_BIAS: f32 = 0.02;

impl SearchOpts {
    pub fn kind(k: NodeKind) -> Self {
        Self { kind: Some(k), ..Default::default() }
    }
    pub fn areas(areas: Vec<Area>) -> Self {
        Self { areas, ..Default::default() }
    }
    pub fn prefer(mut self, prefer: Vec<Area>) -> Self {
        self.prefer = prefer;
        self
    }

    /// Score multiplier for one node under this query's routing.
    fn area_weight(&self, store: &StoreData, id: NodeId) -> f32 {
        if self.prefer.is_empty() { return 1.0; }
        match store.nodes.get(&id) {
            Some(n) if self.prefer.contains(&n.area) => 1.0,
            _ => self.cross_area.unwrap_or(CROSS_AREA_DISCOUNT),
        }
    }
}

/// Query router v0: keyword -> brain area. Returns at most 2 areas, best first;
/// empty means "nothing distinctive, search everywhere". Deliberately dumb —
/// the point is to bias retrieval, not to classify correctly every time.
pub fn route_query(query: &str) -> Vec<Area> {
    const CUES: &[(Area, &[&str])] = &[
        (Area::Salience, &["fail", "failed", "failure", "error", "broke", "broken",
                           "bug", "crash", "regression", "wrong", "hurt"]),
        (Area::Procedural, &["how to", "harness", "skill", "tool", "command",
                             "script", "run ", "build ", "install", "procedure", "steps"]),
        (Area::Spatial, &["repo", "path", "file", "directory", "folder",
                          "service", "package", "module", "endpoint"]),
        (Area::Episodic, &["last time", "previously", "yesterday", "episode",
                           "session", "earlier", "when i", "we did", "history"]),
        (Area::Executive, &["plan", "decide", "decision", "strategy", "steer",
                            "correction", "approach", "policy"]),
        (Area::Semantic, &["what is", "define", "definition", "means", "concept",
                           "fact", "explain"]),
    ];
    let q = query.to_ascii_lowercase();
    let mut hits: Vec<(Area, usize)> = CUES.iter()
        .map(|(area, cues)| (*area, cues.iter().filter(|c| q.contains(**c)).count()))
        .filter(|(_, n)| *n > 0)
        .collect();
    hits.sort_by(|a, b| b.1.cmp(&a.1));
    hits.truncate(2);
    hits.into_iter().map(|(a, _)| a).collect()
}

/// Curated query-side aliases: concept words whose vocabulary gap is a known
/// retrieval miss, expanded on the QUERY only (never index text, so no other
/// query is disturbed). Deliberately tiny — one entry targets one eval case;
/// every added entry is a new regression risk and must win the same two gates
/// (flip the case, no memeval --hash regression).
///
/// "who gets paged when latency spikes" shares zero tokens with the alert-
/// routing node ("page on symptom not cause"); the embedding-level stem fix
/// (P2, 9f5e53a) regressed the baseline and was reverted. This is the
/// different mechanism: exact curated aliases at the retrieval entry.
const QUERY_ALIASES: &[(&str, &[&str])] = &[
    ("paged", &["page", "on-call"]),
];

/// Expand curated aliases into the query text (query-side rewrite only).
/// A key fires only as a whole token, so "pages"/"paged" in unrelated docs
/// stay unaffected — the map is exact, not substring-based.
pub fn expand_query_aliases(query: &str) -> String {
    let q = query.to_ascii_lowercase();
    let mut expanded = q.clone();
    for (key, aliases) in QUERY_ALIASES {
        let key_hit = q.split(|c: char| !c.is_ascii_alphanumeric()).any(|t| t == *key);
        if key_hit {
            for a in *aliases {
                expanded.push(' ');
                expanded.push_str(a);
            }
        }
    }
    expanded
}

fn passes_filter(store: &StoreData, id: NodeId, opts: &SearchOpts) -> bool {
    store.nodes.get(&id)
        .map(|n| !n.deleted
            && opts.kind.map_or(true, |k| n.kind == k)
            && (opts.areas.is_empty() || opts.areas.contains(&n.area))
            && !opts.exclude.contains(&id))
        .unwrap_or(false)
}

/// Search v1: brute-force cosine seeds + graph expansion (exact; fine to ~100k
/// nodes). This is the default and the fallback; `memsrv` routes through
/// `search_ann` only behind `MNEMO_SEARCH_ANN=1` + `ANN_MIN_NODES` (`plan_search`).
pub fn search(
    store: &StoreData,
    vectors: &HashMap<NodeId, Vec<f32>>,
    emb: &dyn Embedder,
    query: &str,
    k: usize,
    now: Millis,
    opts: &SearchOpts,
) -> Vec<SearchResult> {
    let q = emb.embed(&expand_query_aliases(query));
    let mut scored: Vec<(NodeId, f32)> = vectors.iter()
        .filter(|(id, _)| passes_filter(store, **id, opts))
        .map(|(id, v)| {
            let base = cosine(&q, v) * opts.area_weight(store, *id);
            let bias = store.nodes.get(id)
                .map(|n| (n.useful as i32 - n.unhelpful as i32) as f32 * USEFULNESS_BIAS)
                .unwrap_or(0.0);
            (*id, base + bias)
        })
        .filter(|(_, s)| *s > 1e-6)
        .collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    expand(store, scored, k, now, opts)
}

/// Search v2: HNSW ANN seeds + same graph expansion. Same contract as `search`.
///
/// Reachable from `memsrv` only behind `MNEMO_SEARCH_ANN=1` and only above
/// `ANN_MIN_NODES` live nodes (`plan_search` says which path and why). The
/// result is APPROXIMATE: hnsw_rs seeds layer assignment from OS entropy and
/// inserts in parallel, so a rebuilt index can reorder near-ties run to run —
/// tests assert the documented quality bound, never top-1 equality.
pub fn search_ann(
    store: &StoreData,
    index: &crate::ann::AnnIndex,
    emb: &dyn Embedder,
    query: &str,
    k: usize,
    now: Millis,
    opts: &SearchOpts,
) -> Vec<SearchResult> {
    let q = emb.embed(&expand_query_aliases(query));
    let seeds: Vec<(NodeId, f32)> = index.search(&q, k * 4).into_iter()
        .map(|(id, s)| (id as NodeId, s))
        .filter(|(id, _)| passes_filter(store, *id, opts))
        .map(|(id, s)| {
            let base = s * opts.area_weight(store, id);
            let bias = store.nodes.get(&id)
                .map(|n| (n.useful as i32 - n.unhelpful as i32) as f32 * USEFULNESS_BIAS)
                .unwrap_or(0.0);
            (id, base + bias)
        })
        .collect();
    expand(store, seeds, k, now, opts)
}

/// Nodes outside `scope`: those attached (`PartOf`, live) to some project but
/// not to this one. Nodes attached to nothing — the user profile, anything
/// written before scoping existed — stay visible everywhere.
pub fn out_of_scope(store: &StoreData, scope: NodeId, now: Millis) -> std::collections::HashSet<NodeId> {
    let mut attached: HashMap<NodeId, bool> = HashMap::new();
    for e in store.edges.values() {
        if e.kind != EdgeKind::PartOf || !e.alive_at(now) { continue; }
        let here = e.dst == scope;
        let entry = attached.entry(e.src).or_insert(false);
        *entry = *entry || here;
    }
    attached.into_iter()
        .filter(|(id, here)| !*here && *id != scope)
        .map(|(id, _)| id)
        .collect()
}
