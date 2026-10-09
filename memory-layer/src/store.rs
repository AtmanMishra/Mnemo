//! In-memory store. Every mutation goes through `apply` (journal-able) so
//! snapshot+replay is exact.
use crate::model::*;
use std::collections::HashMap;

/// Log kinds that record a FACT and repeat its value in `detail`. The facts
/// block of `state_of` is the fact record — the current value per key — so these
/// lines are not re-stated there: a value that has since been superseded would
/// otherwise reach the model through a second path, unmarked (#24). They stay in
/// the log on disk and come back verbatim from `history`.
const FACT_LOG_KINDS: [&str; 2] = ["fact_added", "fact_superseded"];

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct StoreData {
    pub nodes: HashMap<NodeId, Node>,
    pub edges: HashMap<EdgeId, Edge>,
    pub next_node: NodeId,
    pub next_edge: EdgeId,
    pub next_fact: u64,
    /// ML-1: memoized `state_of` snapshots. DERIVED scratch state — never
    /// journaled, never serialized (a snapshot must replay identically);
    /// invalidated by `apply` on any op that touches the node.
    #[serde(skip)]
    pub state_memo: HashMap<NodeId, String>,
}

impl StoreData {
    pub fn new() -> Self {
        Self { next_node: 1, next_edge: 1, next_fact: 1, ..Default::default() }
    }

    /// Apply one operation. Returns Result because ops reference ids that must exist.
    pub fn apply(&mut self, op: &Op) -> Result<(), String> {
        match op {
            Op::CreateNode { id, kind, label, at } => {
                if self.nodes.contains_key(id) {
                    return Err(format!("node {id} exists"));
                }
                self.nodes.insert(*id, Node {
                    id: *id, kind: *kind, area: Area::for_kind(*kind), label: label.clone(),
                    facts: vec![], log: vec![LogEntry {
                        at: *at, kind: "created".into(),
                        detail: format!("node created as {label}"),
                    }],
                    context: vec![], created_at: *at, deleted: false,
                    useful: 0, unhelpful: 0,
                });
                self.next_node = self.next_node.max(id.saturating_add(1));
                self.state_memo.remove(id);
            }
            Op::AddFact { node, fact_id, key, value, at } => {
                let n = self.get_mut(*node)?;
                n.facts.push(Fact {
                    id: *fact_id, key: key.clone(), value: value.clone(),
                    status: FactStatus::Active, created_at: *at, superseded_by: None,
                });
                n.log.push(LogEntry { at: *at, kind: "fact_added".into(), detail: format!("{key}: {value}") });
                self.next_fact = self.next_fact.max(fact_id.saturating_add(1));
                self.state_memo.remove(node);
            }
            Op::SupersedeFact { node, old_fact, new_key, new_value, new_fact_id, at } => {
                let n = self.get_mut(*node)?;
                let old = n.facts.iter_mut().find(|f| f.id == *old_fact)
                    .ok_or_else(|| format!("fact {old_fact} not on node {node}"))?;
                old.status = FactStatus::Superseded;
                old.superseded_by = Some(*new_fact_id);
                // One current value per key (#24). Any OTHER fact still active
                // under `new_key` is retired by this same replacement — it
                // keeps its id and value and gains `superseded_by`, so nothing
                // is deleted — because two live values under one key is the
                // ambiguity that handed a model both versions of a changed
                // constraint. This also converges data written before the
                // write path superseded: the next write under that key
                // retires every stale copy at once.
                let mut also_retired = 0usize;
                for f in n.facts.iter_mut() {
                    if f.status == FactStatus::Active && f.key == *new_key {
                        f.status = FactStatus::Superseded;
                        f.superseded_by = Some(*new_fact_id);
                        also_retired += 1;
                    }
                }
                n.facts.push(Fact {
                    id: *new_fact_id, key: new_key.clone(), value: new_value.clone(),
                    status: FactStatus::Active, created_at: *at, superseded_by: None,
                });
                n.log.push(LogEntry {
                    at: *at, kind: "fact_superseded".into(),
                    detail: if also_retired > 0 {
                        format!("{} (+{also_retired} other live '{new_key}') -> {}: {}",
                            old_fact, new_fact_id, new_value)
                    } else {
                        format!("{} -> {}: {}", old_fact, new_fact_id, new_value)
                    },
                });
                self.next_fact = self.next_fact.max(new_fact_id.saturating_add(1));
                // superseding changes the node's derived text (a fact's status
                // is what puts it in — or takes it out of — the facts block)
                self.state_memo.remove(node);
            }
            Op::SetArea { node, area, at } => {
                let n = self.get_mut(*node)?;
                let old = n.area;
                n.area = *area;
                n.log.push(LogEntry {
                    at: *at, kind: "area_set".into(),
                    detail: format!("{old:?} -> {area:?}"),
                });
                self.state_memo.remove(node);
            }
            Op::DeleteNode { node, hard, at } => {
                let n = self.get_mut(*node)?;
                n.deleted = true;
                n.log.push(LogEntry { at: *at, kind: "deleted".into(), detail: format!("hard={hard}") });
                if *hard {
                    self.nodes.remove(node);
                }
                // kill outgoing/incoming context edges (soft-invalidated by Unlink ops at journal level)
                self.state_memo.remove(node);
            }
            Op::Link { id, src, dst, kind, at } => {
                self.must_exist(*src)?; self.must_exist(*dst)?;
                if self.edges.contains_key(id) {
                    return Err(format!("edge {id} exists"));
                }
                self.edges.insert(*id, Edge {
                    id: *id, src: *src, dst: *dst, kind: *kind,
                    weight: 0.5, valid_from: *at, invalid_at: None,
                    success: 0, failure: 0,
                });
                self.next_edge = self.next_edge.max(id.saturating_add(1));
                // a new edge topologically touches both endpoints (future
                // state text may cite feeders); invalidate defensively
                self.state_memo.remove(src);
                self.state_memo.remove(dst);
            }
            Op::Unlink { edge, at } => {
                let e = self.edge_mut(*edge)?;
                e.invalid_at = Some(*at);
            }
            Op::Reweight { edge, delta, .. } => {
                let e = self.edge_mut(*edge)?;
                e.weight = (e.weight + delta).clamp(0.0, 1.0);
            }
            Op::RecordOutcome { edge, success, at } => {
                let e = self.edge_mut(*edge)?;
                if *success { e.success += 1; e.weight = (e.weight + 0.05).min(1.0); }
                else { e.failure += 1; e.weight = (e.weight - 0.10).max(0.0); }
                let _ = at; // weight change is the record
            }
            Op::PushContext { to, chunk, .. } => {
                self.get_mut(*to)?.context.push(chunk.clone());
                self.state_memo.remove(to);
            }
            Op::CommitLog { node, kind, detail, at } => {
                self.get_mut(*node)?.log.push(LogEntry {
                    at: *at, kind: kind.clone(), detail: detail.clone(),
                });
                self.state_memo.remove(node);
            }
            Op::RecordUsefulness { node, useful, .. } => {
                // ML-2: a vote is counted, never LOGGED — node_text embeds
                // a node's last-3 log entries, and vote noise would dilute
                // the very content the vote rewards, drifting a heavily-
                // voted node away from its topic. The counters stay
                // model-visible through `state_of` text, which is display-
                // only and never embedded.
                let n = self.get_mut(*node)?;
                if *useful { n.useful += 1; } else { n.unhelpful += 1; }
                self.state_memo.remove(node);
            }
        }
        Ok(())
    }

    fn get_mut(&mut self, id: NodeId) -> Result<&mut Node, String> {
        self.nodes.get_mut(&id).ok_or_else(|| format!("node {id} missing"))
    }
    fn must_exist(&self, id: NodeId) -> Result<(), String> {
        if self.nodes.contains_key(&id) { Ok(()) } else { Err(format!("node {id} missing")) }
    }
    fn edge_mut(&mut self, id: EdgeId) -> Result<&mut Edge, String> {
        self.edges.get_mut(&id).ok_or_else(|| format!("edge {id} missing"))
    }

    /// DERIVED state snapshot for the agent to read cheaply.
    ///
    /// ML-1: memoized per node — the TUI memory pane and search enrichment
    /// call this a lot and it is pure recompute (active facts + last-5 log +
    /// context chunks). Every journal op that touches the node invalidates
    /// the entry in `apply`, so the memo is never stale under the
    /// replay-exact mutation discipline. Errors (missing node) are not
    /// memoized.
    pub fn state_of(&mut self, id: NodeId) -> Result<String, String> {
        if let Some(s) = self.state_memo.get(&id) {
            return Ok(s.clone());
        }
        let n = self.nodes.get(&id).ok_or_else(|| format!("node {id} missing"))?;
        let mut s = format!("[{:?}/{:?}] {} #{}\n", n.kind, n.area, n.label, n.id);
        s.push_str("facts:\n");
        for f in n.active_facts() {
            s.push_str(&format!("  - {}: {}\n", f.key, f.value));
        }
        // #24: a key has one current value, so retired ones are NOT rendered as
        // live instructions — two versions of a changed constraint with nothing
        // marking which is current was the failure this fixes. They are still
        // in the store (status Superseded, `superseded_by` set) and reachable
        // through `history`; saying so here is what keeps supersede-never-delete
        // visible instead of silent.
        let retired = n.facts.len() - n.active_facts().count();
        if retired > 0 {
            let noun = if retired == 1 { "value" } else { "values" };
            s.push_str(&format!(
                "  ({retired} retired {noun} kept as history, not current — the facts above are the current answer)\n"
            ));
        }
        s.push_str("recent log:\n");
        // #24: the facts block above IS the fact record — the current value per
        // key. A fact-write log line repeats a value that may since have been
        // superseded, and that repeated copy is how the retired instruction got
        // its second path into the model's prompt (nothing marked it as stale;
        // the line was just a line). So those two kinds are not re-stated here:
        // the current value is above, the retired ones are in `history`, and the
        // log on disk is unchanged either way.
        for l in n.log.iter()
            .filter(|l| !FACT_LOG_KINDS.contains(&l.kind.as_str()))
            .rev().take(5).collect::<Vec<_>>().iter().rev()
        {
            s.push_str(&format!("  [{}] {}: {}\n", l.at, l.kind, l.detail));
        }
        s.push_str(&format!("context chunks: {}\n", n.context.len()));
        for c in &n.context {
            s.push_str(&format!("  <- #{} [dim {}]: {}\n", c.from, c.dim, c.note));
        }
        if n.useful > 0 || n.unhelpful > 0 {
            s.push_str(&format!("usefulness votes: {} useful / {} unhelpful\n", n.useful, n.unhelpful));
        }
        self.state_memo.insert(id, s.clone());
        Ok(s)
    }

    /// All live SuppliesContext edges feeding a node, strongest first.
    pub fn feeders_of(&self, dst: NodeId, now: Millis) -> Vec<&Edge> {
        let mut v: Vec<_> = self.edges.values()
            .filter(|e| e.kind == EdgeKind::SuppliesContext && e.dst == dst && e.alive_at(now))
            .collect();
        v.sort_by(|a, b| b.weight.total_cmp(&a.weight));
        v
    }
}
