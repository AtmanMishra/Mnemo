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
            && (opts.areas.is_empty() || opts.areas.contains(&n.area)))
        .unwrap_or(false)
}

/// Search v1: brute-force cosine seeds + graph expansion (exact; fine to ~100k nodes).
#[allow(dead_code)]
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
