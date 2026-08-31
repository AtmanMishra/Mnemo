//! ML-1: in-memory caches for the hot read path.
//!
//! Two caches, both pure performance, both transparent:
//!   - `SearchCache`: memsrv `search` results, keyed by the RESOLVED inputs
//!     (normalized query, area filter, k). It sits AFTER scoring, so a hit
//!     returns exactly what the uncached path would — worst case it is a
//!     no-op (LRU miss).
//!   - the `state_of` memo lives in `StoreData` and is invalidated by
//!     `apply` (see store.rs).
//!
//! Deliberate limits, per research/memory-layer-improvements.md ML-1:
//! no TTL, no shared cache, no external store. Stale-after-mutation is
//! accepted for now — a memory layer is a cache of its own facts anyway —
//! and if stale reads ever show up the fix is per-key invalidation on the
//! journal ops that touch matching nodes, not a time-based cache.
use crate::model::Area;
use std::collections::{HashMap, VecDeque};

/// Default bound for search-result caching (entries, not bytes).
pub const SEARCH_CACHE_CAP: usize = 256;

/// Cache key = the resolved inputs of one search. `prefer` is deliberately
/// NOT in the key: it derives from the query via `route_query` when no area
/// filter was given, and equals the filter otherwise — so (query, areas, k)
/// fully determines the result.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SearchKey {
    /// Normalized query text (case + whitespace collapsed).
    pub query: String,
    /// The hard area filter (empty = every area).
    pub areas: Vec<Area>,
    pub k: usize,
}

/// Case/whitespace normalization — enough to collapse queries the underlying
/// path (routing + embedder) treats identically, not a semantic normalizer.
pub fn normalize_query(q: &str) -> String {
    q.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase()
}

/// Minimal LRU: HashMap for lookup + VecDeque for recency order
/// (back = least recently used). O(n) touch is fine at cap ~256.
pub struct SearchCache<V> {
    map: HashMap<SearchKey, V>,
    order: VecDeque<SearchKey>,
    cap: usize,
}

impl<V> SearchCache<V> {
    pub fn new(cap: usize) -> Self {
        Self { map: HashMap::new(), order: VecDeque::new(), cap }
    }

    pub fn get(&mut self, key: &SearchKey) -> Option<&V> {
        if !self.map.contains_key(key) {
            return None;
        }
        // touch: move to front (most recently used)
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            if let Some(k) = self.order.remove(pos) {
                self.order.push_front(k);
            }
        }
        self.map.get(key)
    }

    pub fn put(&mut self, key: SearchKey, value: V) {
        if let Some(pos) = self.order.iter().position(|k| *k == key) {
            self.order.remove(pos); // refresh keeps one entry per key
        }
        self.map.insert(key.clone(), value);
        self.order.push_front(key);
        while self.order.len() > self.cap {
            if let Some(lru) = self.order.pop_back() {
                self.map.remove(&lru);
            }
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}