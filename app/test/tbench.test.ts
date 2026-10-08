/**
 * The Terminal-Bench runner's pure parts: the pytest rule that decides a task
 * is resolved, and the layer added after every FROM.
 */
import { test, expect } from "bun:test";
import { resolved, withHostCa } from "../eval/tbench.ts";

test("resolved: something passed and nothing failed or errored", () => {
  expect(resolved("PASSED tests/a.py::x\nPASSED tests/a.py::y\n").resolved).toBe(true);
  expect(resolved("PASSED tests/a.py::x\nFAILED tests/a.py::y - assert\n")).toMatchObject({ resolved: false, passed: 1, failed: 1 });
  expect(resolved("ERROR tests/a.py - ImportError\n").resolved).toBe(false);
  expect(resolved("collected 0 items\n").resolved).toBe(false);
  // a test merely named PASSED in the log, not at a line start, does not count
  expect(resolved("  checking PASSED tests\n").resolved).toBe(false);
});

test("every stage of a multi-stage build gets the CA and uv, and nothing else changes", () => {
  const out = withHostCa("FROM a AS build\nRUN make\nFROM --platform=linux/amd64 b\nCOPY --from=build /x /x\n");
  expect(out.match(/COPY host-ca.crt/g)).toHaveLength(2);
  expect(out.match(/COPY uv\//g)).toHaveLength(2);
  expect(out).toContain("RUN make\n");
  expect(out).toContain("COPY --from=build /x /x");
});
