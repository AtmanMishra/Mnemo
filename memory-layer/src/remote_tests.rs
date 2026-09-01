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
}
