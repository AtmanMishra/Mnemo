/**
 * Retry an observable assertion until async work and Ink's layout have caught up.
 * The timeout is a ceiling, not a wait: a passing check returns at once. It is long enough
 * for a starved Windows runner, and shorter than CI's 30 s test timeout, which catches a hang.
 */
export async function waitFor(assert: () => void, timeout = 15_000): Promise<void> {
  const deadline = performance.now() + timeout;
  for (;;) {
    try {
      assert();
      return;
    } catch (error) {
      if (performance.now() >= deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Ink reads keys only once a `useInput` has subscribed to stdin; a key written before that is dropped. */
export async function listening(stdin: { listenerCount(event: string): number }): Promise<void> {
  await waitFor(() => {
    if (stdin.listenerCount("readable") === 0) throw new Error("nothing reads stdin yet");
  });
}
