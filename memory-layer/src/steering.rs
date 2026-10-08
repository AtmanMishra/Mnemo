//! P2: rule-based steering engine (spec section 4).
//! Pure planner: inspects the store, returns journal-able Ops. Applying them is
//! the caller's job (apply + journal append keeps replay exact).
use crate::model::*;
use crate::store::StoreData;
use crate::vec::tokenize;
use std::collections::HashSet;

/// A known correction: "fact X on node N is wrong, truth is ...".
#[derive(Debug, Clone)]
pub struct Correction {
    pub node: NodeId,
    pub old_fact: u64,
    pub new_key: String,
    pub new_value: String,
}

/// Ids for nodes/facts/edges the plan will create.
#[derive(Debug, Clone, Copy)]
struct Ids {
    next_node: NodeId,
    next_fact: u64,
    next_edge: EdgeId,
}

impl Ids {
    fn from_store(s: &StoreData) -> Self {
        Self { next_node: s.next_node, next_fact: s.next_fact, next_edge: s.next_edge }
    }
    fn node(&mut self) -> NodeId { let id = self.next_node; self.next_node += 1; id }
    fn fact(&mut self) -> u64 { let id = self.next_fact; self.next_fact += 1; id }
    fn edge(&mut self) -> EdgeId { let id = self.next_edge; self.next_edge += 1; id }
}

const BLAME_PENALTY: f32 = -0.10;
const SWITCH_THRESHOLD: f32 = 0.2;

/// How a caller wants a failure handled.
#[derive(Debug, Clone, Copy)]
pub struct SteerOpts {
    /// Create a `gap:` node when nothing was implicated. A tool error is not a
    /// knowledge gap (audit F6), so the agent turns this off for those.
    pub gap: bool,
    /// Reuse the pain marker of an identical earlier failure (same normalized
    /// signature) and count the recurrence, instead of a new node each time
    /// (audit F5). Off by default so the original planner is unchanged.
    pub dedupe_pain: bool,
}

impl Default for SteerOpts {
    fn default() -> Self { Self { gap: true, dedupe_pain: false } }
}

/// A failure's identity across sessions: lowercase, digits collapsed, quotes
/// and whitespace normalized, capped. "line 42" and "line 57" are one failure.
pub fn failure_signature(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_digit = false;
    let mut last_space = false;
    for c in text.chars() {
        if c.is_ascii_digit() {
            if !last_digit { out.push('#'); }
            last_digit = true;
            last_space = false;
            continue;
        }
        last_digit = false;
        let c = if c == '"' || c == '`' || c == '\'' { ' ' } else { c };
        if c.is_whitespace() {
            if !last_space && !out.is_empty() { out.push(' '); }
            last_space = true;
            continue;
        }
        last_space = false;
        out.extend(c.to_lowercase());
    }
    out.trim().chars().take(160).collect()
}

#[derive(Debug, Default)]
pub struct SteerNotes {
    /// How often this failure has now been seen, when pain markers are deduplicated.
    pub occurrences: Option<u32>,
    pub pain_node: Option<NodeId>,
    pub blamed_feeders: Vec<(EdgeId, NodeId)>,
    pub superseded_on: Option<NodeId>,
    pub gap_node: Option<NodeId>,
    pub switched_from: Option<EdgeId>,
    pub unblamed_feeders: Vec<EdgeId>,
}

/// Failure steering. Emits ops that:
///   0. capture a SALIENCE pain marker (fast capture, before any decision),
///   1. log the failure on the episode ("model-visible means logged"),
///   2. down-weight implicated feeder edges (lexical overlap of failure text
///      with each feeder's active facts),
///   3. apply the correction (supersede a specific stale fact) if given,
///   4. switch: if an implicated edge falls below threshold and another live
///      feeder with higher weight exists, rewire SuppliesContext to it,
///   5. if nothing at all was implicated, create a GAP aspect node capturing
///      unknown knowledge and wire it as the episode's context source.
pub fn steer(
    store: &StoreData,
    episode: NodeId,
    failure_detail: &str,
    correction: Option<&Correction>,
    now: Millis,
) -> Result<(Vec<Op>, SteerNotes), String> {
    steer_with(store, episode, failure_detail, correction, SteerOpts::default(), now)
}

/// `steer` with explicit options (see `SteerOpts`).
pub fn steer_with(
    store: &StoreData,
    episode: NodeId,
    failure_detail: &str,
    correction: Option<&Correction>,
    opts: SteerOpts,
    now: Millis,
) -> Result<(Vec<Op>, SteerNotes), String> {
    let ep = store.nodes.get(&episode)
        .ok_or_else(|| format!("episode node {episode} missing"))?;
    if ep.kind != NodeKind::TaskEpisode {
        return Err(format!("node {episode} is {:?}, not a TaskEpisode", ep.kind));
    }
    let mut ids = Ids::from_store(store);
    let mut ops = Vec::new();
    let mut notes = SteerNotes::default();

    // 1. log it
    ops.push(Op::CommitLog { node: episode, kind: "outcome".into(),
        detail: failure_detail.into(), at: now });

    // 0/1b. pain marker FIRST, before any executive decision below. Amygdala
    // logic: capture that it hurt, cheaply and unconditionally; deciding what
    // to do about it is the rest of this function.
    let signature = failure_signature(failure_detail);
    let earlier = if opts.dedupe_pain {
        store.nodes.values()
            .filter(|n| !n.deleted && n.area == Area::Salience)
            .find(|n| n.active_facts().any(|f| f.key == "signature" && f.value == signature))
    } else {
        None
    };
    let pain = match earlier {
        Some(n) => {
            // The same failure again: one marker, a higher count, and a log
            // line naming the episode — recurrence is the signal, not volume.
            let count = n.active_facts().find(|f| f.key == "occurrences")
                .and_then(|f| f.value.parse::<u32>().ok()).unwrap_or(1) + 1;
            let fid = ids.fact();
            match n.active_facts().find(|f| f.key == "occurrences") {
                Some(f) => ops.push(Op::SupersedeFact { node: n.id, old_fact: f.id,
                    new_key: "occurrences".into(), new_value: count.to_string(), new_fact_id: fid, at: now }),
                None => ops.push(Op::AddFact { node: n.id, fact_id: fid,
                    key: "occurrences".into(), value: count.to_string(), at: now }),
            }
            ops.push(Op::CommitLog { node: n.id, kind: "recurred".into(),
                detail: format!("in episode #{episode}"), at: now });
            notes.occurrences = Some(count);
            n.id
        }
        None => {
            let pain = ids.node();
            ops.push(Op::CreateNode { id: pain, kind: NodeKind::Aspect,
                label: format!("pain: {}", truncate(failure_detail, 60)), at: now });
            ops.push(Op::SetArea { node: pain, area: Area::Salience, at: now });
            let pfid = ids.fact();
            ops.push(Op::AddFact { node: pain, fact_id: pfid, key: "failure".into(),
                value: failure_detail.into(), at: now });
            if opts.dedupe_pain {
                let sfid = ids.fact();
                ops.push(Op::AddFact { node: pain, fact_id: sfid, key: "signature".into(),
                    value: signature.clone(), at: now });
                let ofid = ids.fact();
                ops.push(Op::AddFact { node: pain, fact_id: ofid, key: "occurrences".into(),
                    value: "1".into(), at: now });
                notes.occurrences = Some(1);
            }
            pain
        }
    };
    let peid = ids.edge();
    // episode CITES the marker: DerivedFrom keeps it out of feeders_of(), so a
    // pain marker can never become a blame target for the next failure.
    ops.push(Op::Link { id: peid, src: episode, dst: pain,
        kind: EdgeKind::DerivedFrom, at: now });
    notes.pain_node = Some(pain);

    let q_tokens: HashSet<String> = tokenize(failure_detail).collect();
    let feeders = store.feeders_of(episode, now);

    // 2+3. attribute blame
    let mut implicated: Vec<EdgeId> = Vec::new();
    for e in &feeders {
        let overlap = lexical_overlap(store, e.src, &q_tokens);
        let corrected_here = correction.map_or(false, |c| c.node == e.src);
        if overlap > 0 || corrected_here {
            implicated.push(e.id);
            notes.blamed_feeders.push((e.id, e.src));
            ops.push(Op::RecordOutcome { edge: e.id, success: false, at: now });
        } else {
            notes.unblamed_feeders.push(e.id);
        }
    }

    // 3. correction supersedes the stale fact
    if let Some(c) = correction {
        // validate against current store state
        let ok = store.nodes.get(&c.node).map(|n| {
            n.facts.iter().any(|f| f.id == c.old_fact && f.status == FactStatus::Active)
        }).unwrap_or(false);
        if !ok {
            return Err(format!("correction targets missing/inactive fact {} on node {}", c.old_fact, c.node));
        }
        let fid = ids.fact();
        ops.push(Op::SupersedeFact { node: c.node, old_fact: c.old_fact,
            new_key: c.new_key.clone(), new_value: c.new_value.clone(),
            new_fact_id: fid, at: now });
        notes.superseded_on = Some(c.node);
    }

    // 4. switch away from edges killed by repeated failures
    for eid in implicated.clone() {
        let projected = projected_weight(store, eid, BLAME_PENALTY);
        if projected < SWITCH_THRESHOLD {
            if let Some(alt) = alternate_source(store, episode, eid, now) {
                ops.push(Op::Unlink { edge: eid, at: now });
                let nid = ids.edge();
                ops.push(Op::Link { id: nid, src: alt, dst: episode,
                    kind: EdgeKind::SuppliesContext, at: now });
                notes.switched_from = Some(eid);
            }
        }
    }

    // 5. nothing implicated -> knowledge gap
    if implicated.is_empty() && correction.is_none() && opts.gap {
        let mut focus: Vec<String> = q_tokens.iter().take(8).cloned().collect();
        focus.sort(); // deterministic labels regardless of HashSet order
        focus.truncate(4);
        if focus.is_empty() { focus.push("unknown".into()); }
        let gid = ids.node();
        ops.push(Op::CreateNode { id: gid, kind: NodeKind::Aspect,
            label: format!("gap: {}", focus.join(" ")), at: now });
        let fid = ids.fact();
        ops.push(Op::AddFact { node: gid, fact_id: fid,
            key: "missing_knowledge".into(),
            value: format!("agent lacked knowledge relevant to: {failure_detail}"), at: now });
        let eid = ids.edge();
        ops.push(Op::Link { id: eid, src: gid, dst: episode,
            kind: EdgeKind::SuppliesContext, at: now });
        notes.gap_node = Some(gid);
    }

    Ok((ops, notes))
}

/// Success path: reinforce every feeder of the episode (Hebbian nudge).
pub fn reinforce(
    store: &StoreData,
    episode: NodeId,
    success_detail: &str,
    now: Millis,
) -> Result<Vec<Op>, String> {
    let ep = store.nodes.get(&episode)
        .ok_or_else(|| format!("episode node {episode} missing"))?;
    if ep.kind != NodeKind::TaskEpisode {
        return Err(format!("node {episode} is not a TaskEpisode"));
    }
    let mut ops = vec![Op::CommitLog { node: episode, kind: "outcome".into(),
        detail: success_detail.into(), at: now }];
    for e in store.feeders_of(episode, now) {
        ops.push(Op::RecordOutcome { edge: e.id, success: true, at: now });
    }
    Ok(ops)
}

fn truncate(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}...", &s[..i]),
        None => s.to_string(),
    }
}

fn lexical_overlap(store: &StoreData, node: NodeId, query: &HashSet<String>) -> usize {
    let mut hay: HashSet<String> = HashSet::new();
    if let Some(n) = store.nodes.get(&node) {
        for f in n.active_facts() {
            hay.extend(tokenize(&format!("{} {}", f.key, f.value)));
        }
        hay.extend(tokenize(&n.label));
    }
    hay.intersection(query).count()
}

fn projected_weight(store: &StoreData, edge: EdgeId, delta: f32) -> f32 {
    store.edges.get(&edge).map(|e| (e.weight + delta).clamp(0.0, 1.0)).unwrap_or(0.0)
}

fn alternate_source(store: &StoreData, episode: NodeId, exclude: EdgeId, now: Millis) -> Option<NodeId> {
    store.feeders_of(episode, now).iter()
        .filter(|e| e.id != exclude && e.weight > SWITCH_THRESHOLD)
        .map(|e| e.src)
        .next()
}
