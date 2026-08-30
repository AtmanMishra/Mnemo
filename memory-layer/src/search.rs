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
            if let Some(nb_id) = nb {
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
    let q = emb.embed(query);
    let mut scored: Vec<(NodeId, f32)> = vectors.iter()
        .filter(|(id, _)| passes_filter(store, **id, opts))
        .map(|(id, v)| (*id, cosine(&q, v) * opts.area_weight(store, *id)))
        .filter(|(_, s)| *s > 1e-6)
        .collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    expand(store, scored, k, now)
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
    let q = emb.embed(query);
    let seeds: Vec<(NodeId, f32)> = index.search(&q, k * 4).into_iter()
        .map(|(id, s)| (id as NodeId, s))
        .filter(|(id, _)| passes_filter(store, *id, opts))
        .map(|(id, s)| (id, s * opts.area_weight(store, id)))
        .collect();
    expand(store, seeds, k, now)
}
