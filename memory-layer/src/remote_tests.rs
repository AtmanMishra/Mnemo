//! 6f96adc6: embed calls must be time/retry bounded. memsrv's RPC loop is
//! single-threaded and embed() sits on it — an unbounded HTTP call stalls
//! every client. These tests pin the bound against a server that never
//! responds (worst case for a timeout).
#[cfg(test)]
mod embed_bound_tests {
    use crate::remote::OpenRouterEmbedder;
    use crate::vec::Embedder as _; // embed() is a trait method
    use std::time::{Duration, Instant};

    #[test]
    fn embed_against_a_silent_server_returns_within_the_retry_budget() {
        // bind but never accept: connections queue in the backlog, requests
        // are written, and no response ever comes — the timeout path
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let _listener = listener; // held open for the test's lifetime

        let dir = std::env::temp_dir()
            .join(format!("memlayer-embed-bound-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // 300 ms per attempt: a timeout is non-retryable (retries only fire
        // on HTTP 429/503), so the silent-server budget is one 300 ms attempt;
        // the full retry budget (2x300 ms + 1 s backoff) is the ceiling either way
        let e = OpenRouterEmbedder::new_with_endpoint(
            "test-key".into(), "test-model".into(), &dir,
            format!("http://127.0.0.1:{port}/embeddings"),
            Duration::from_millis(300),
        );

        let start = Instant::now();
        let v = e.embed("uncached text that must hit the silent server");
        let elapsed = start.elapsed();

        // failure degrades to an empty vector (the node scores 0), never a
        // panic and never an unbounded stall
        assert!(v.is_empty(), "a failed embed must fall back to an empty vector");
        // generous slack over the ~1.6 s budget: this test guards against
        // 'unbounded', not against exact timings
        assert!(elapsed < Duration::from_secs(8),
            "embed must respect the retry budget, took {elapsed:?}");
    }

    #[test]
    fn retry_budget_is_small_by_construction() {
        // pin the stall bound: attempts x timeout + backoff between each.
        // If someone raises these constants, they must re-justify the
        // single-threaded-loop stall budget here.
        use crate::remote::{EMBED_ATTEMPTS, EMBED_BACKOFF, EMBED_TIMEOUT};
        assert!(EMBED_ATTEMPTS <= 2, "more than one retry re-opens the stall");
        assert!(EMBED_TIMEOUT <= Duration::from_secs(10), "per-call timeout must stay <= 10s");
        assert!(EMBED_BACKOFF <= Duration::from_secs(1), "backoff must stay <= 1s");
    }

    #[test]
    fn a_local_server_is_asked_without_a_key_when_none_is_set() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            // headers and body can arrive in separate reads: read until the body is complete
            let mut raw = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = sock.read(&mut buf).unwrap();
                if n == 0 { break; }
                raw.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&raw).to_lowercase();
                if let Some(end) = text.find("\r\n\r\n") {
                    let len = text.lines()
                        .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                        .unwrap_or(0);
                    if raw.len() >= end + 4 + len { break; }
                }
            }
            let req = String::from_utf8_lossy(&raw).to_lowercase();
            let body = r#"{"data":[{"embedding":[0.6,0.8]}]}"#;
            write!(sock, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            req
        });
        let dir = std::env::temp_dir().join(format!("memlayer-embed-local-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let e = OpenRouterEmbedder::new_with_endpoint(
            String::new(), "nomic-embed-text".into(), &dir,
            format!("http://127.0.0.1:{port}/v1/embeddings"),
            Duration::from_secs(5),
        );
        assert_eq!(e.embed("hello"), vec![0.6, 0.8]);
        let req = server.join().unwrap();
        assert!(req.contains("nomic-embed-text"));
        assert!(!req.contains("authorization:"), "no key, no Authorization header");
    }

    #[test]
    fn only_https_or_this_machine_may_receive_memories() {
        use crate::remote::allowed_endpoint;
        assert!(allowed_endpoint("https://api.example.com/v1/embeddings"));
        assert!(allowed_endpoint("http://localhost:11434/v1/embeddings"));
        assert!(allowed_endpoint("http://127.0.0.1/v1/embeddings"));
        assert!(!allowed_endpoint("http://localhost.evil.com/v1"));
        assert!(!allowed_endpoint("http://192.168.1.5:11434/v1/embeddings"));
    }

    #[cfg(unix)]
    #[test]
    fn the_embed_cache_is_replaced_whole_and_private() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let dir = std::env::temp_dir().join(format!("memlayer-embed-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let e = OpenRouterEmbedder::new_with_endpoint(
            "k".into(), "m".into(), &dir, "https://api.example.com/v1/embeddings".into(), Duration::from_secs(1),
        );
        let cache = dir.join("embed-cache.json");
        let mut map = std::collections::HashMap::new();
        map.insert("a".to_string(), vec![1.0f32]);
        e.persist(&map);
        let first = std::fs::metadata(&cache).unwrap();
        assert_eq!(first.permissions().mode() & 0o077, 0, "the cache holds memories' vectors: private");
        map.insert("b".to_string(), vec![2.0f32]);
        e.persist(&map);
        // A new file renamed over the old one (a new inode), never the old one
        // truncated and rewritten in place where a reader can catch it half-done.
        assert_ne!(std::fs::metadata(&cache).unwrap().ino(), first.ino());
        let back: std::collections::HashMap<String, Vec<f32>> = serde_json::from_slice(&std::fs::read(&cache).unwrap()).unwrap();
        assert_eq!(back.len(), 2);
        let leftovers: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|d| d.ok())
            .filter(|d| d.file_name().to_string_lossy().ends_with(".tmp")).collect();
        assert!(leftovers.is_empty());
    }
}
