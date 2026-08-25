//! Embedding abstraction + offline hashing embedder (P1 default).
//! A real local model later just implements Embedder.
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

pub const DIM: usize = 256;

pub trait Embedder: Send + Sync {
    fn model_name(&self) -> String { "hashing-v1".to_string() }
    fn embed(&self, text: &str) -> Vec<f32>;
}

/// Token-feature hashing: deterministic, no model download, works offline.
/// Bag-of-words with sublinear tf. Good enough to route by shared vocabulary;
/// semantic paraphrase comes when a real model plugs in behind Embedder.
pub struct HashingEmbedder;

impl Embedder for HashingEmbedder {
    fn embed(&self, text: &str) -> Vec<f32> {
        let mut v = vec![0f32; DIM];
        let mut counts: std::collections::HashMap<String, u32> = Default::default();
        for tok in tokenize(text) {
            *counts.entry(tok).or_insert(0) += 1;
        }
        for (tok, c) in counts {
            let w = 1f32 + (c as f32).ln(); // sublinear tf
            // two independent hash projections reduce collision damage
            let mut h1 = DefaultHasher::new();
            tok.hash(&mut h1);
            let slot1 = (h1.finish() as usize) % DIM;
            v[slot1] += w;
            let mut h2 = DefaultHasher::new();
            (tok.clone(), "salt").hash(&mut h2);
            let slot2 = (h2.finish() as usize) % DIM;
            v[slot2] += w * 0.5;
        }
        let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for x in &mut v { *x /= norm; }
        }
        v
    }
}

pub fn tokenize(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| s.len() > 1)
        .map(|s| s.to_ascii_lowercase())
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    dot // both are L2-normalized
}
