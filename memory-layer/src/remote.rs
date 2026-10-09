//! OpenRouter embedding provider + on-disk response cache.
//! User choice: OPENROUTER_API_KEY set -> remote embeddings; else offline hashing.
//!
//! 6f96adc6: embed calls are TIME-BOUNDED and RETRY-BOUNDED. The memsrv RPC
//! loop is single-threaded by design, and embed() sits on that loop — an
//! unbounded HTTP call (ureq 3 defaults to NO timeout) would stall every
//! client behind it. Bounds: 2 attempts (initial + one retry) x a 10 s
//! global timeout + a fixed 1 s backoff = ~21 s worst case, vs unbounded
//! per attempt x 4 attempts + 9 s of exponential sleeps before.
//!
//! Why the minimal fix and not a full async redesign: the remote path is
//! per-text cached on disk (only uncached texts hit the API), memeval and
//! the whole test suite run on the hashing embedder (no key), so an async
//! redesign could not be validated against real remote behaviour without
//! regressing the eval — and the hash fallback stays first-class: no key
//! -> hashing, and a failed remote call degrades to an empty vector (the
//! node simply scores 0 for that query), never an error, never a stall.
//! If journal-embedded agents ever make the remote path hot, the next step
//! is a background warm loop; that is deliberately NOT built yet.
use crate::vec::Embedder;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// End-to-end timeout for one embed HTTP call (DNS .. body read).
pub const EMBED_TIMEOUT: Duration = Duration::from_secs(10);
/// Total attempts for one embed call (initial + one retry).
pub const EMBED_ATTEMPTS: u32 = 2;
/// Fixed backoff between attempts (rate-limit courtesy, not a stall).
pub const EMBED_BACKOFF: Duration = Duration::from_secs(1);

const DEFAULT_ENDPOINT: &str = "https://openrouter.ai/api/v1/embeddings";

pub struct OpenRouterEmbedder {
    api_key: String,
    model: String,
    endpoint: String,
    cache_path: PathBuf,
    cache: Mutex<HashMap<String, Vec<f32>>>,
    /// every call through this agent carries the global timeout above
    agent: ureq::Agent,
}

impl OpenRouterEmbedder {
    /// Full constructor (endpoint/timeout injectable for tests and
    /// self-hosted gateways via OPENROUTER_EMBED_URL / OPENROUTER_EMBED_TIMEOUT_MS).
    pub fn new_with_endpoint(
        api_key: String,
        model: String,
        cache_dir: &Path,
        endpoint: String,
        timeout: Duration,
    ) -> Self {
        let cache_path = cache_dir.join("embed-cache.json");
        let cache = std::fs::read(&cache_path).ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_default();
        let agent = ureq::config::Config::builder()
            .timeout_global(Some(timeout))
            .build()
            .new_agent();
        Self { api_key, model, endpoint, cache_path, cache: Mutex::new(cache), agent }
    }

    /// Load disk cache (text-hash -> vector) so identical text never re-hits the API.
    pub fn new(api_key: String, model: String, cache_dir: &Path) -> Self {
        // The API key and the text of every memory go to this address, so it must be
        // encrypted, or a server on this machine (tests, a local model).
        let endpoint = std::env::var("OPENROUTER_EMBED_URL")
            .ok()
            .filter(|u| {
                let ok = u.starts_with("https://")
                    || ["http://localhost", "http://127.0.0.1", "http://[::1]"].iter().any(|p| {
                        u.strip_prefix(p).map_or(false, |rest| rest.is_empty() || rest.starts_with(':') || rest.starts_with('/'))
                    });
                if !ok { eprintln!("[memsrv] ignoring OPENROUTER_EMBED_URL: it must be https:// or a local address"); }
                ok
            })
            .unwrap_or_else(|| DEFAULT_ENDPOINT.into());
        let timeout = std::env::var("OPENROUTER_EMBED_TIMEOUT_MS").ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(Duration::from_millis)
            .unwrap_or(EMBED_TIMEOUT);
        Self::new_with_endpoint(api_key, model, cache_dir, endpoint, timeout)
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
        // bounded: EMBED_ATTEMPTS tries, each under the agent's global
        // timeout — the RPC loop that calls this can never stall unbounded
        for attempt in 0..EMBED_ATTEMPTS {
            if attempt > 0 {
                std::thread::sleep(EMBED_BACKOFF);
            }
            match self.agent.post(&self.endpoint)
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
