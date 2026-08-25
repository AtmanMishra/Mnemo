//! OpenRouter embedding provider + on-disk response cache.
//! User choice: OPENROUTER_API_KEY set -> remote embeddings; else offline hashing.
use crate::vec::Embedder;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub struct OpenRouterEmbedder {
    api_key: String,
    model: String,
    cache_path: PathBuf,
    cache: Mutex<HashMap<String, Vec<f32>>>,
}

impl OpenRouterEmbedder {
    /// Load disk cache (text-hash -> vector) so identical text never re-hits the API.
    pub fn new(api_key: String, model: String, cache_dir: &Path) -> Self {
        let cache_path = cache_dir.join("embed-cache.json");
        let cache = std::fs::read(&cache_path).ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_default();
        Self { api_key, model, cache_path, cache: Mutex::new(cache) }
    }

    pub fn from_env(cache_dir: &Path) -> Option<Self> {
        let api_key = std::env::var("OPENROUTER_API_KEY").ok()?;
        if api_key.is_empty() { return None; }
        let model = std::env::var("OPENROUTER_EMBED_MODEL")
            .unwrap_or_else(|_| "liquid/lfm-2.5-embedding-350m:free".into());
        Some(Self::new(api_key, model, cache_dir))
    }

    fn key_of(&self, text: &str) -> String {
        let mut h = Sha256::new();
        h.update(self.model.as_bytes());
        h.update(b"\0");
        h.update(text.as_bytes());
        let digest = h.finalize();
        digest.iter().map(|b| format!("{:02x}", b)).collect::<String>()
    }

    fn call_api(&self, text: &str) -> Result<Vec<f32>, String> {
        let body = serde_json::json!({ "model": self.model, "input": text });
        let mut last_err = String::new();
        for attempt in 0..4u32 {
            if attempt > 0 {
                std::thread::sleep(std::time::Duration::from_millis(1500 * (1 << (attempt - 1))));
            }
            match ureq::post("https://openrouter.ai/api/v1/embeddings")
                .header("Authorization", &format!("Bearer {}", self.api_key))
                .header("Content-Type", "application/json")
                .send(serde_json::to_string(&body).map_err(|e| e.to_string())?)
            {
                Ok(mut r) => {
                    let v: serde_json::Value =
                        r.body_mut().read_json().map_err(|e| e.to_string())?;
                    let vec: Vec<f32> = v["data"][0]["embedding"]
                        .as_array()
                        .ok_or_else(|| "malformed response: no data[0].embedding".to_string())?
                        .iter()
                        .filter_map(|x| x.as_f64().map(|f| f as f32))
                        .collect();
                    if vec.is_empty() { return Err("empty embedding returned".into()); }
                    return Ok(vec);
                }
                Err(ureq::Error::StatusCode(c)) if c == 429 || c == 503 => {
                    last_err = format!("HTTP {c} (rate limit / unavailable)");
                }
                Err(e) => return Err(format!("request failed: {e}")),
            }
        }
        Err(last_err)
    }

    fn persist(&self, map: &HashMap<String, Vec<f32>>) {
        if let Some(dir) = self.cache_path.parent() { let _ = std::fs::create_dir_all(dir); }
        if let Ok(raw) = serde_json::to_vec(map) {
            let _ = std::fs::write(&self.cache_path, raw);
        }
    }
}

impl OpenRouterEmbedder {
    pub fn model_name(&self) -> String { self.model.clone() }
}

impl Embedder for OpenRouterEmbedder {
    fn embed(&self, text: &str) -> Vec<f32> {
        let key = self.key_of(text);
        if let Some(v) = self.cache.lock().unwrap().get(&key) {
            return v.clone();
        }
        match self.call_api(text) {
            Ok(v) => {
                let mut map = self.cache.lock().unwrap();
                map.insert(key, v.clone());
                self.persist(&map);
                v
            }
            Err(e) => {
                eprintln!("[openrouter] warning: {e}; using empty vector for this text");
                Vec::new()
            }
        }
    }
}
