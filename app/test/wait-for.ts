/** Retry an observable assertion until async work and Ink's layout have caught up. */
export async function waitFor(assert: () => void, timeout = 5000): Promise<void> {
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
