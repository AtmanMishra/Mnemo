import { expect, test } from "bun:test";
import { isFinalProviderError } from "../src/extensions/final-errors.ts";

test("a refused key or an empty balance is final", () => {
  for (const m of ["402 Insufficient account funds", "401 Unauthorized", "403: forbidden", "Error: 402 {\"error\":{}}", "Incorrect API key provided", "Payment required"])
    expect(isFinalProviderError(m)).toBe(true);
});

test("a transient failure is left to pi's retry", () => {
  for (const m of ["503 Service Unavailable", "429 rate limit", "fetch failed", "overloaded", "timed out after 401 ms", undefined, ""])
    expect(isFinalProviderError(m)).toBe(false);
});
