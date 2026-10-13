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
import { hyperlink, setLinks } from "../src/ui/link.ts";
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
