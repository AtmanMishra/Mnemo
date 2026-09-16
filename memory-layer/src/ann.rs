//! ANN index over node vectors using hnsw_rs.
//!
//! Construction is NONDETERMINISTIC by design: `hnsw_rs` seeds layer
//! assignment from OS entropy (`LayerGenerator` uses `StdRng::from_os_rng`)
//! and `parallel_insert` interleaves Rayon threads, so two builds of the same
//! vectors can produce different graphs and swap near-ties. Callers must
//! treat results as approximate — assert a quality bound against brute force
//! (see `search_tests::p1::hnsw_ann_agrees_with_brute_within_documented_bound`),
//! never exact top-1 equality.
use hnsw_rs::prelude::*;
use std::collections::HashMap;

pub struct AnnIndex<'a> {
    hnsw: Hnsw<'a, f32, DistCosine>,
}

impl<'a> AnnIndex<'a> {
    /// Build from a full vector map (rebuild-on-update strategy for P1;
    /// incremental inserts come when graphs get big enough to need it).
    pub fn build(vectors: &HashMap<u64, Vec<f32>>) -> AnnIndex<'a> {
        let n = vectors.len();
        let hnsw = Hnsw::<f32, DistCosine>::new(
            16,                     // max nb connections per layer
            (n * 2).max(256),       // max elements
            8,                      // max layers
            64,                     // ef_construction
            DistCosine {},
        );
        let items: Vec<(&Vec<f32>, usize)> =
            vectors.iter().map(|(id, v)| (v, *id as usize)).collect();
        hnsw.parallel_insert(&items);
        Self { hnsw }
    }

    /// Returns (node_id, cosine_similarity) sorted best-first.
    pub fn search(&self, query: &[f32], k: usize) -> Vec<(u64, f32)> {
        self.hnsw
            .search(query, k, 48)
            .into_iter()
            .map(|nb| (nb.d_id as u64, 1.0 - nb.distance)) // DistCosine is a distance
            .collect()
    }
}
