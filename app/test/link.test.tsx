/**
 * OSC 8 links: a file in a tool title and a link in an answer are clickable
 * when links are on; off (tests, pipes, MNEMO_LINKS=0) the text is unchanged,
 * and a scheme a terminal should not open is never linked.
 */
import { test, expect, afterEach } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { BlockView } from "../src/ui/components/Blocks.tsx";
import { MotionContext } from "../src/ui/components/motion.ts";
import { hyperlink, openBrowser, setLinks } from "../src/ui/link.ts";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

afterEach(() => setLinks(false));

const view = (block: Parameters<typeof BlockView>[0]["block"]) =>
  render(
    <MotionContext.Provider value={false}>
      <BlockView block={block} cwd="/work/shop" expanded={false} />
    </MotionContext.Provider>,
  ).lastFrame()!;

test("off by default: plain text", () => {
  expect(hyperlink("https://x.io", "x")).toBe("x");
  expect(view({ kind: "tool", id: "t", name: "read", args: { path: "src/app.ts" }, status: "done", output: "" })).not.toContain("\x1b]8;");
});

test("on: files and answers link, unsafe schemes do not", () => {
  setLinks(true);
  expect(hyperlink("javascript:alert(1)", "x")).toBe("x");
  expect(hyperlink("https://x.io/\x07evil", "x")).toBe("x");
  const tool = view({ kind: "tool", id: "t", name: "read", args: { path: "src/app.ts" }, status: "done", output: "" });
  expect(tool).toContain(`\x1b]8;;${pathToFileURL(path.resolve("/work/shop", "src/app.ts")).href}\x07src/app.ts\x1b]8;;\x07`);
  const answer = view({ kind: "assistant", id: "a", text: "See [the docs](https://example.com/docs).", done: true });
  expect(answer).toContain("\x1b]8;;https://example.com/docs\x07");
  expect(answer).toContain("the docs");
});

test("a sign-in link is one link (on) or one unwrapped line (off), and a device code stands out", () => {
  const url = `https://claude.ai/oauth/authorize?${"code=true&".repeat(55)}state=abc`;
  const block = { kind: "notice" as const, id: "n", tone: "info" as const, text: "Open this link to sign in", extra: { code: "WDJB-MJHT", links: [{ url }] } };
  const off = view(block);
  expect(off.split("\n").some((l) => l.trim() === url)).toBe(true);
  expect(off).toMatch(/^\s+WDJB-MJHT$/m);
  setLinks(true);
  const on = view(block);
  expect(on).toContain(`\x1b]8;;${url}\x07`);
  expect(on.split("\n").every((l) => l.replace(/\x1b\]8;;[^\x07]*\x07/g, "").length <= 100)).toBe(true);
});

test("the browser is not opened where it cannot or should not be", () => {
  expect(openBrowser("https://x.io", { BROWSER: "none", DISPLAY: ":0" }, "linux")).toBe(false);
  expect(openBrowser("https://x.io", { BROWSER: "true" }, "darwin")).toBe(false);
  expect(openBrowser("https://x.io", {}, "linux")).toBe(false);
  expect(openBrowser("javascript:alert(1)", {}, "darwin")).toBe(false);
  // A BROWSER that cannot be started fails quietly, without waiting.
  expect(openBrowser("https://x.io", { BROWSER: "/nonexistent/browser" }, "linux")).toBe(true);
});
