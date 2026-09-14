//! Consolidation: replay Episodic/Salience nodes and compact recurring themes
//! into Semantic "lesson" nodes. The sleep cycle of research/brain-areas-design.md.
//!
//! Pure planner like `steering`: returns journal-able Ops, applying them is the
//! caller's job. Deterministic and idempotent — running it twice in a row emits
//! nothing the second time.
use crate::model::*;
use crate::store::StoreData;
use crate::vec::tokenize;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

/// THE TWO CONSOLIDATION THRESHOLDS, documented together because they read
/// alike and mean different things — each is named for what it counts:
///
/// - MIN_SOURCES_FOR_THEME (this constant, `min_sources_for_theme()` below):
///   how many DISTINCT SOURCE NODES must share a theme before it distils into
///   a lesson — "what counts as recurring", inside one consolidation pass.
///   Default 2, override MNEMO_MIN_OCCURRENCES (any positive integer).
/// - CONSOLIDATE_EVERY_N_EPISODES (agent/extensions/memory-layer.ts): how many
///   NEW EPISODES a session must add before the shutdown consolidation pass
///   RUNS AT ALL — "when to consolidate". Default 3, override
///   MNEMO_CONSOLIDATE_THRESHOLD.
pub const DEFAULT_MIN_SOURCES_FOR_THEME: usize = 2;

/// MIN_SOURCES_FOR_THEME as configured for this process, read ONCE so a
/// tester can set MNEMO_MIN_OCCURRENCES without a rebuild. Lazy on the first
/// consolidation request rather than at process start (Rust has no module
/// initialiser); the env is stable for a process's lifetime either way.
pub fn min_sources_for_theme() -> usize {
    static CONFIGURED: OnceLock<usize> = OnceLock::new();
    *CONFIGURED.get_or_init(|| {
        min_sources_from(std::env::var("MNEMO_MIN_OCCURRENCES").ok().as_deref())
    })
}

/// Parses an MNEMO_MIN_OCCURRENCES value. Anything that is not a positive
/// integer — absent, empty, junk, zero — keeps the default, so a mistyped
/// override still consolidates instead of disabling every lesson.
pub(crate) fn min_sources_from(raw: Option<&str>) -> usize {
    raw.and_then(|s| s.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_MIN_SOURCES_FOR_THEME)
}

/// Cap on tokens in a lesson label, so labels stay readable.
const MAX_SIGNATURE_TOKENS: usize = 4;
/// A lesson needs a real theme, not one word in common: two sources that share
/// only "checkout" are the same project, not the same lesson.
const MIN_SHARED_TOKENS: usize = 2;

/// Words that recur everywhere and carry no theme.
const STOPWORDS: &[&str] = &[
    "the", "and", "for", "with", "that", "this", "from", "was", "were", "has",
    "had", "not", "but", "you", "our", "its", "it", "is", "are", "when", "what",
    "why", "how", "all", "any", "out", "into", "onto", "after", "before",
    "again", "pain", "failure", "failed", "error", "agent", "node", "task",
];

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Lesson {
    pub label: String,
    pub occurrences: usize,
    pub sources: Vec<NodeId>,
    /// Existing lesson node this updates, if any.
    pub node: Option<NodeId>,
}

fn theme_tokens(store: &StoreData, id: NodeId) -> BTreeSet<String> {
    let Some(n) = store.nodes.get(&id) else { return BTreeSet::new() };
    let mut text = n.label.clone();
    for f in n.active_facts() {
        text.push(' ');
        text.push_str(&f.value);
    }
    tokenize(&text)
        .filter(|t| t.len() > 2 && !STOPWORDS.contains(&t.as_str()))
        .collect()
}

/// Plan the consolidation pass. Returns (ops, lessons) — lessons describe what
/// the ops do, for the CLI/RPC caller to print.
pub fn consolidate(store: &StoreData, now: Millis) -> (Vec<Op>, Vec<Lesson>) {
    // 1. what to replay: lived experience, not already-distilled knowledge
    let sources: Vec<NodeId> = {
        let mut v: Vec<NodeId> = store.nodes.values()
            .filter(|n| !n.deleted && matches!(n.area, Area::Episodic | Area::Salience))
            .map(|n| n.id)
            .collect();
        v.sort();
        v
    };
    let tokens: BTreeMap<NodeId, BTreeSet<String>> = sources.iter()
        .map(|id| (*id, theme_tokens(store, *id)))
        .collect();

    // 2. a token is a theme once it shows up in min_sources_for_theme()
    //    distinct sources (read once for the whole pass)
    let min_sources = min_sources_for_theme();
    let mut df: BTreeMap<&str, usize> = BTreeMap::new();
    for set in tokens.values() {
        for t in set { *df.entry(t.as_str()).or_insert(0) += 1; }
    }
    let recurring: BTreeSet<&str> = df.iter()
        .filter(|(_, n)| **n >= min_sources)
        .map(|(t, _)| *t)
        .collect();

    // 3. one candidate group per recurring token, then keep only groups whose
    //    members share a real theme. Groups that end up with the same shared
    //    tokens collapse into one lesson ("helm"+"rollback"+"timed" -> one).
    let mut groups: BTreeMap<Vec<String>, Vec<NodeId>> = BTreeMap::new();
    for token in &recurring {
        let members: Vec<NodeId> = tokens.iter()
            .filter(|(_, set)| set.contains(*token))
            .map(|(id, _)| *id)
            .collect();
        if members.len() < min_sources { continue; }
        let shared: Vec<String> = members.iter()
            .map(|id| &tokens[id])
            .cloned()
            .reduce(|a, b| a.intersection(&b).cloned().collect())
            .unwrap_or_default()
            .into_iter()
            .filter(|t| recurring.contains(t.as_str()))
            .take(MAX_SIGNATURE_TOKENS)
            .collect();
        if shared.len() < MIN_SHARED_TOKENS { continue; }
        groups.entry(shared).or_insert(members);
    }

    let mut ops = Vec::new();
    let mut lessons = Vec::new();
    let mut next_node = store.next_node;
    let mut next_fact = store.next_fact;
    for (sig, srcs) in groups {
        if srcs.len() < min_sources { continue; }
        let label = format!("lesson: {}", sig.join(" "));
        let sources_value = srcs.iter().map(|id| format!("#{id}")).collect::<Vec<_>>().join(" ");
        let existing = store.nodes.values()
            .find(|n| !n.deleted && n.label == label && n.area == Area::Semantic);

        match existing {
            // already distilled and unchanged -> emit nothing (idempotent)
            Some(n) if n.active_facts().any(|f| f.key == "sources" && f.value == sources_value) => {
                lessons.push(Lesson { label, occurrences: srcs.len(), sources: srcs, node: Some(n.id) });
            }
            // seen before but with new evidence -> supersede the old count
            Some(n) => {
                let old = n.active_facts().find(|f| f.key == "sources").map(|f| f.id);
                let fid = next_fact; next_fact += 1;
                match old {
                    Some(old_fact) => ops.push(Op::SupersedeFact {
                        node: n.id, old_fact, new_key: "sources".into(),
                        new_value: sources_value, new_fact_id: fid, at: now }),
                    None => ops.push(Op::AddFact {
                        node: n.id, fact_id: fid, key: "sources".into(),
                        value: sources_value, at: now }),
                }
                lessons.push(Lesson { label, occurrences: srcs.len(), sources: srcs, node: Some(n.id) });
            }
            // brand new lesson
            None => {
                let id = next_node; next_node += 1;
                ops.push(Op::CreateNode { id, kind: NodeKind::Aspect, label: label.clone(), at: now });
                ops.push(Op::SetArea { node: id, area: Area::Semantic, at: now });
                let fid = next_fact; next_fact += 1;
                ops.push(Op::AddFact { node: id, fact_id: fid,
                    key: "recurring_theme".into(),
                    value: format!("seen in {} episodes: {}", srcs.len(), sig.join(" ")), at: now });
                let fid2 = next_fact; next_fact += 1;
                ops.push(Op::AddFact { node: id, fact_id: fid2,
                    key: "sources".into(), value: sources_value, at: now });
                // cite the evidence so the lesson is reachable from its episodes
                lessons.push(Lesson { label, occurrences: srcs.len(), sources: srcs, node: Some(id) });
            }
        }
    }
    (ops, lessons)
}
