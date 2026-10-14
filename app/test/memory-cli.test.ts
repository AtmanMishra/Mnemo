/** `mnemo memory setup`: the commands it prints run this binary, even from a path with spaces. */
import { test, expect } from "bun:test";
import { setupText, shellQuote } from "../src/memory-cli.ts";

test("a binary path with spaces stays one argument in every printed command", () => {
  const argv = ["/Users/Jane Doe/.mnemo/bin/bun", "/Users/Jane Doe/src/mnemo/app/bin/mnemo.ts"];
  const claude = setupText("claude-code", argv, "darwin")!;
  const settings = JSON.parse(claude.slice(claude.indexOf("{"), claude.lastIndexOf("}") + 1)) as {
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  };
  expect(settings.hooks.SessionStart![0]!.hooks[0]!.command).toBe("'/Users/Jane Doe/.mnemo/bin/bun' '/Users/Jane Doe/src/mnemo/app/bin/mnemo.ts' memory hook");
  expect(claude).toContain("-- '/Users/Jane Doe/.mnemo/bin/bun' '/Users/Jane Doe/src/mnemo/app/bin/mnemo.ts' memory mcp");
  const codex = setupText("codex", argv, "darwin")!;
  expect(codex).toContain('command = "/Users/Jane Doe/.mnemo/bin/bun"');
  expect(codex).toContain('args = ["/Users/Jane Doe/src/mnemo/app/bin/mnemo.ts","memory","mcp"]');
  const win = setupText("claude-code", ["C:\\Users\\Jane Doe\\.mnemo\\bin\\mnemo.exe"], "win32")!;
  expect(win).toContain('-- "C:\\Users\\Jane Doe\\.mnemo\\bin\\mnemo.exe" memory mcp');
  expect(shellQuote("/usr/local/bin/mnemo")).toBe("/usr/local/bin/mnemo");
  expect(shellQuote("it's", "linux")).toBe(`'it'\\''s'`);
});
