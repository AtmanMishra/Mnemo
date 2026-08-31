//! Core data model: nodes (facts/state/log/context), typed edges, journal ops.
use serde::{Deserialize, Serialize};

pub type NodeId = u64;
pub type EdgeId = u64;
pub type Millis = u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NodeKind {
    Aspect,      // one facet of a skill/domain
    TaskEpisode, // one work session / outcome
    Entity,      // concrete thing: repo, service, path
    Harness,     // generated plugin/skill
    Outcome,     // record of applying knowledge: worked or not
}

/// Specialized memory region. See research/brain-areas-design.md.
/// Derived from `NodeKind` at creation, but stored on the node so it can be
/// reassigned (Salience/Executive nodes have no dedicated kind).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum Area {
    Episodic,   // hippocampus: episodes + outcomes
    #[default]
    Semantic,   // neocortex: aspect facts
    Procedural, // cerebellum: harnesses, skills
    Spatial,    // parietal: repos, paths, services
    Salience,   // amygdala: failure/pain markers
    Executive,  // prefrontal: steering decisions, plans
}

impl Area {
    pub fn for_kind(kind: NodeKind) -> Area {
        match kind {
            NodeKind::TaskEpisode | NodeKind::Outcome => Area::Episodic,
            NodeKind::Aspect => Area::Semantic,
            NodeKind::Harness => Area::Procedural,
            NodeKind::Entity => Area::Spatial,
        }
    }

    pub fn parse(s: &str) -> Option<Area> {
        match s.to_ascii_lowercase().as_str() {
            "episodic" => Some(Area::Episodic),
            "semantic" => Some(Area::Semantic),
            "procedural" => Some(Area::Procedural),
            "spatial" => Some(Area::Spatial),
            "salience" => Some(Area::Salience),
            "executive" => Some(Area::Executive),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FactStatus {
    Active,
    Superseded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fact {
    pub id: u64,
    pub key: String,
    pub value: String,
    pub status: FactStatus,
    pub created_at: Millis,
    pub superseded_by: Option<u64>,
}

/// Append-only log entry. "model-visible means logged".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub at: Millis,
    pub kind: String,
    pub detail: String,
}

/// Context chunk pushed by predecessors. Vector content is P1; P0 stores it raw.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextChunk {
    pub from: NodeId,
    pub dim: usize,
    #[serde(default)]
    pub vec: Vec<f32>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: NodeId,
    pub kind: NodeKind,
    /// Brain area. Defaults to `Area::for_kind(kind)`; `Op::SetArea` reassigns.
    /// Old snapshots predate this field, hence serde default.
    #[serde(default)]
    pub area: Area,
    pub label: String,
    pub facts: Vec<Fact>,
    pub log: Vec<LogEntry>,
    /// DERIVED. Never stored as source of truth; computed by `state_of`.
    pub context: Vec<ContextChunk>,
    pub created_at: Millis,
    pub deleted: bool,
}

impl Node {
    pub fn active_facts(&self) -> impl Iterator<Item = &Fact> {
        self.facts.iter().filter(|f| f.status == FactStatus::Active)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EdgeKind {
    SuppliesContext, // src owes dst correct context (the push contract)
    PartOf,          // aspect -> domain cluster membership
    DerivedFrom,     // episode/outcome cites aspects used
    Supersedes,      // temporal replacement
    ActivatedWith,   // co-retrieval association (Hebbian)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    pub id: EdgeId,
    pub src: NodeId,
    pub dst: NodeId,
    pub kind: EdgeKind,
    pub weight: f32,
    pub valid_from: Millis,
    pub invalid_at: Option<Millis>,
    pub success: u32,
    pub failure: u32,
}

impl Edge {
    pub fn alive_at(&self, t: Millis) -> bool {
        self.invalid_at.is_none() && t >= self.valid_from && self.weight > 0.0
    }
}

/// One journaled mutation. Replay(ops) == current state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Op {
    CreateNode {
        id: NodeId,
        kind: NodeKind,
        label: String,
        at: Millis,
    },
    AddFact {
        node: NodeId,
        fact_id: u64,
        key: String,
        value: String,
        at: Millis,
    },
    SupersedeFact {
        node: NodeId,
        old_fact: u64,
        new_key: String,
        new_value: String,
        new_fact_id: u64,
        at: Millis,
    },
    SetArea {
        node: NodeId,
        area: Area,
        at: Millis,
    },
    DeleteNode {
        node: NodeId,
        hard: bool,
        at: Millis,
    },
    Link {
        id: EdgeId,
        src: NodeId,
        dst: NodeId,
        kind: EdgeKind,
        at: Millis,
    },
    Unlink {
        edge: EdgeId,
        at: Millis,
    }, // sets invalid_at (soft)
    Reweight {
        edge: EdgeId,
        delta: f32,
        at: Millis,
    },
    RecordOutcome {
        edge: EdgeId,
        success: bool,
        at: Millis,
    }, // also nudges weight
    PushContext {
        to: NodeId,
        chunk: ContextChunk,
        at: Millis,
    },
    CommitLog {
        node: NodeId,
        kind: String,
        detail: String,
        at: Millis,
    },
}
