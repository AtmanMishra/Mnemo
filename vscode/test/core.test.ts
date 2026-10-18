import { describe, expect, test } from "bun:test";
import { inside, launchArgs, plain, reference, relativeTo } from "../src/core.ts";

describe("launchArgs", () => {
  test("default starts plain, plan is read-only, continue resumes", () => {
    expect(launchArgs("default", false)).toEqual([]);
    expect(launchArgs("plan", false)).toEqual(["--plan"]);
    expect(launchArgs("plan", true)).toEqual(["--continue", "--plan"]);
  });

  test("never turns an approval prompt off, whatever the setting says", () => {
    for (const mode of ["yolo", "accept-edits", "--yolo", "plan --yolo", ""]) {
      const args = launchArgs(mode, true);
      expect(args).not.toContain("--yolo");
      expect(args).not.toContain("--accept-edits");
    }
  });
});

describe("plain", () => {
  test("removes escape sequences and newlines so text cannot submit or drive the terminal", () => {
    const out = plain("a\x1b[2Jb\r\nc\u0085d");
    expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(out).not.toContain("\n");
  });
});

describe("reference", () => {
  test("points at lines and never carries the code itself", () => {
    expect(reference("src/a.ts", { start: 3, end: 9 })).toBe("Look at src/a.ts lines 3-9: ");
    expect(reference("src/a.ts", { start: 4, end: 4 })).toBe("Look at src/a.ts line 4: ");
    expect(reference("src/a.ts")).toBe("Look at src/a.ts: ");
  });

  test("a hostile file name stays one line", () => {
    const text = reference("x\n\x1b]0;pwned\x07; rm -rf ~.ts");
    expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  test("uses forward slashes on Windows paths", () => {
    expect(reference("src\\a.ts")).toBe("Look at src/a.ts: ");
  });
});

describe("relativeTo", () => {
  test("relative inside the folder, nothing outside it", () => {
    expect(relativeTo("/w/proj", "/w/proj/src/a.ts")).toBe("src/a.ts");
    expect(relativeTo("C:\\w\\proj", "C:\\w\\proj\\src\\a.ts")).toBe("src/a.ts");
    expect(relativeTo("/w/proj", "/w/projx/a.ts")).toBeUndefined();
    expect(relativeTo("/w/proj", "/etc/passwd")).toBeUndefined();
  });

  test("inside compares whole path segments", () => {
    expect(inside("/w/proj", "/w/proj")).toBe(true);
    expect(inside("/w/proj/", "/w/proj/a")).toBe(true);
    expect(inside("/w/proj", "/w/proj-evil/a")).toBe(false);
  });
});

import { composerDraft, forwardable, rpcArgs } from "../src/core.ts";

describe("rpcArgs", () => {
  test("rpc first, plan and continue pass through, trust only when asked", () => {
    expect(rpcArgs("default", false, false)).toEqual(["--rpc"]);
    expect(rpcArgs("plan", true, true)).toEqual(["--rpc", "--continue", "--plan", "--trust-project"]);
  });

  test("never an option that turns approvals off", () => {
    for (const mode of ["yolo", "accept-edits", "--yolo"]) expect(rpcArgs(mode, false, false).join(" ")).not.toMatch(/yolo|accept-edits/);
  });
});

describe("forwardable", () => {
  test("only the commands the panel uses", () => {
    expect(forwardable({ type: "submit", text: "hi" })).toEqual({ type: "submit", text: "hi" });
    expect(forwardable({ type: "answer", id: 3, answer: { kind: "yes" } })).toBeDefined();
    expect(forwardable({ type: "quit" })).toBeUndefined();
    expect(forwardable({ type: "constructor" })).toBeUndefined();
    expect(forwardable({ type: "submit", id: "x" })).toBeUndefined();
    expect(forwardable("submit")).toBeUndefined();
    expect(forwardable([{ type: "submit" }])).toBeUndefined();
  });
});

describe("composerDraft", () => {
  test("fences the code with a longer fence than any inside it", () => {
    const d = composerDraft("a.md", { start: 1, end: 2 }, "x ``` y", "markdown");
    expect(d.startsWith("Look at a.md lines 1-2:")).toBe(true);
    expect(d).toContain("````markdown\nx ``` y\n````");
  });

  test("no selection is just the reference", () => {
    expect(composerDraft("a.ts", undefined, undefined, "ts")).toBe("Look at a.ts: ");
  });
});
