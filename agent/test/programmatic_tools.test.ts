/**
 * 4.6 + 4.7: programmatic tool calling. The kernel here is a real python3
 * process running the real bridge; only the tools are fakes.
 */
import { test, after } from "node:test";
import assert from "node:assert";
import { IPyKernel, ipyRunTool } from "../src/tools/ipy_run.ts";
import { makeKernelDispatcher, resultText } from "../src/tools/kernel_tools.ts";
import { textResult, type SeaTool } from "../src/tools/types.ts";
import { decideApproval } from "../extensions/approval-gate.ts";
import { DEFAULT_PERMISSIONS, type Permissions } from "../src/permissions.ts";
import { Type } from "typebox";

const kernels: IPyKernel[] = [];
function kernel(dispatcher: Parameters<IPyKernel["setToolDispatcher"]>[0]): IPyKernel {
  const k = new IPyKernel();
  k.setToolDispatcher(dispatcher);
  kernels.push(k);
  return k;
}
after(() => { for (const k of kernels) k.stop(); });

function fakeTool(name: string, fn: (args: any) => string): SeaTool {
  return {
    name, label: name, description: name,
    parameters: Type.Object({}),
    execute: async (_id, params) => textResult(fn(params)),
  };
}

const allow = async () => ({});

test("submitted code can call a host tool and use the value", async () => {
  const seen: any[] = [];
  const tools = [fakeTool("read_file", (a) => { seen.push(a); return `contents of ${a.path}`; })];
  const k = kernel(makeKernelDispatcher(tools, allow));

  const res = await k.run(`
text = tools.read_file(path="a.ts")
text.upper()
`);
  assert.equal(res.ok, true, res.error ?? "run failed");
  assert.match(res.result ?? "", /CONTENTS OF A\.TS/);
  assert.deepEqual(seen, [{ path: "a.ts" }], "args arrive as keyword arguments");
});

test("a loop makes many tool calls but returns once", async () => {
  // this is the entire point: N calls, one result crossing back to the model
  let calls = 0;
  const tools = [fakeTool("read_file", (a) => { calls += 1; return a.path.endsWith("3") ? "TODO here" : "clean"; })];
  const k = kernel(makeKernelDispatcher(tools, allow));

  const res = await k.run(`
hits = [p for p in ["f1","f2","f3","f4"] if "TODO" in tools.read_file(path=p)]
hits
`);
  assert.equal(res.ok, true, res.error ?? "run failed");
  assert.equal(calls, 4, "every iteration reached the host");
  assert.match(res.result ?? "", /f3/);
  assert.doesNotMatch(res.result ?? "", /f1|f2|f4/, "only the filtered result comes back");
});

test("kernel state persists across runs, so a program can be built up", async () => {
  const tools = [fakeTool("read_file", () => "x")];
  const k = kernel(makeKernelDispatcher(tools, allow));
  assert.equal((await k.run("acc = [tools.read_file(path='a')]")).ok, true);
  const res = await k.run("acc.append(tools.read_file(path='b')); len(acc)");
  assert.equal(res.result, "2");
});

test("a tool_call line is not swallowed by the cell's stdout capture", async () => {
  // the request is written to the buffer captured before redirect_stdout;
  // printing in the same cell must not corrupt either stream
  const tools = [fakeTool("read_file", () => "value")];
  const k = kernel(makeKernelDispatcher(tools, allow));
  const res = await k.run(`
print("before")
v = tools.read_file(path="a")
print("after", v)
v
`);
  assert.equal(res.ok, true, res.error ?? "run failed");
  assert.equal(res.result, "'value'");
  assert.match(res.output ?? "", /before/);
  assert.match(res.output ?? "", /after value/);
  assert.doesNotMatch(res.output ?? "", /tool_call/, "protocol lines must not leak into cell output");
});

test("an unknown tool raises ToolError instead of hanging the kernel", async () => {
  const k = kernel(makeKernelDispatcher([fakeTool("read_file", () => "x")], allow));
  const res = await k.run("tools.no_such_tool()");
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /unknown tool/);
  assert.match(res.error ?? "", /read_file/, "the error should list what IS available");
  // and the kernel is still usable afterwards
  assert.equal((await k.run("1 + 1")).result, "2");
});

test("a throwing tool surfaces as a catchable ToolError", async () => {
  const boom: SeaTool = {
    name: "bash_exec", label: "bash_exec", description: "",
    parameters: Type.Object({}),
    execute: async () => { throw new Error("command not found"); },
  };
  const k = kernel(makeKernelDispatcher([boom], allow));
  const res = await k.run(`
try:
    tools.bash_exec(command="nope")
    out = "no error"
except ToolError as e:
    out = f"caught: {e}"
out
`);
  assert.equal(res.ok, true, res.error ?? "run failed");
  assert.match(res.result ?? "", /caught: command not found/);
});

test("a kernel with no dispatcher fails loudly rather than hanging", async () => {
  const k = kernel(null);
  const res = await k.run("tools.read_file(path='a')");
  assert.equal(res.ok, false);
  // no `tools` object at all when the host wired nothing up
  assert.match(res.error ?? "", /NameError|no tools are available/);
});

// --- 4.7: the gate ---------------------------------------------------------

function gateWith(perms: Permissions, plan = false) {
  return (name: string, args: Record<string, unknown>) =>
    decideApproval({ toolName: name, input: args },
      { confirm: async () => true }, {} as NodeJS.ProcessEnv, false, perms, plan);
}

test("a deny rule blocks a call made from inside generated code", async () => {
  const perms: Permissions = {
    version: 1,
    rules: [{ tool: "bash_exec", pattern: "rm *", action: "deny" }],
    default: "ask",
  };
  let ran = 0;
  const tools = [fakeTool("bash_exec", () => { ran += 1; return "done"; })];
  const k = kernel(makeKernelDispatcher(tools, gateWith(perms)));

  const res = await k.run(`
try:
    tools.bash_exec(command="rm -rf /")
    out = "NOT BLOCKED"
except ToolError as e:
    out = str(e)
out
`);
  assert.equal(res.ok, true, res.error ?? "run failed");
  assert.match(res.result ?? "", /denied by/);
  assert.equal(ran, 0, "the denied tool must not have executed");

  // the same tool with an allowed command still works
  const ok = await k.run(`tools.bash_exec(command="ls")`);
  assert.equal(ok.ok, true, ok.error ?? "run failed");
  assert.equal(ran, 1);
});

test("plan mode blocks writes from inside generated code", async () => {
  let wrote = 0;
  const tools = [
    fakeTool("write_file", () => { wrote += 1; return "written"; }),
    fakeTool("read_file", () => "readable"),
  ];
  const k = kernel(makeKernelDispatcher(tools, gateWith(DEFAULT_PERMISSIONS, true)));

  const res = await k.run(`
try:
    tools.write_file(path="a", content="b")
    out = "NOT BLOCKED"
except ToolError as e:
    out = str(e)
out
`);
  assert.match(res.result ?? "", /plan mode/);
  assert.equal(wrote, 0, "a read-only phase must hold inside the kernel too");
  assert.equal((await k.run(`tools.read_file(path="a")`)).result, "'readable'");
});

test("resultText flattens a tool result to what the program sees", () => {
  assert.equal(resultText(textResult("hello") as any), "hello");
  assert.equal(resultText({ content: [] } as any), "");
  assert.equal(resultText({} as any), "");
});

// --- parallel tool calling ---------------------------------------------

function slowTool(name: string, ms: number, fn: (args: any) => string): SeaTool {
  return {
    name, label: name, description: name,
    parameters: Type.Object({}),
    execute: async (_id, params) => {
      await new Promise((r) => setTimeout(r, ms));
      return textResult(fn(params));
    },
  };
}

test("tools.parallel really runs them at the same time", async () => {
  // the point of the batch is wall-clock: eight 100ms calls in one round trip
  // must not take eight times 100ms
  const tools = [slowTool("read_file", 100, (a) => `contents of ${a.path}`)];
  const k = kernel(makeKernelDispatcher(tools, allow));

  const started = Date.now();
  const res = await k.run(`
paths = [f"f{i}.ts" for i in range(8)]
out = tools.parallel([("read_file", {"path": p}) for p in paths])
out
`);
  const elapsed = Date.now() - started;
  assert.equal(res.ok, true, res.error ?? "run failed");
  assert.match(res.result ?? "", /contents of f0\.ts/);
  assert.match(res.result ?? "", /contents of f7\.ts/);
  assert.ok(elapsed < 500, `8x100ms concurrently should be well under 500ms, took ${elapsed}ms`);
});

test("results come back in the order they were sent", async () => {
  // the fastest call finishing first must not reorder the list
  const tools = [
    slowTool("slow", 120, () => "slow"),
    slowTool("quick", 5, () => "quick"),
  ];
  const k = kernel(makeKernelDispatcher(tools, allow));
  const res = await k.run(`
tools.parallel([("slow", {}), ("quick", {}), ("slow", {})])
`);
  assert.equal(res.ok, true, res.error ?? "run failed");
  assert.equal(res.result, `['slow', 'quick', 'slow']`);
});

test("one failed call does not lose the rest of the batch", async () => {
  const tools = [
    fakeTool("read_file", (a) => {
      if (a.path === "missing.ts") throw new Error("ENOENT: missing.ts");
      return `contents of ${a.path}`;
    }),
  ];
  const k = kernel(makeKernelDispatcher(tools, allow));
  const res = await k.run(`
out = tools.parallel([
    ("read_file", {"path": "a.ts"}),
    ("read_file", {"path": "missing.ts"}),
    ("read_file", {"path": "b.ts"}),
])
[str(x) if isinstance(x, ToolError) else x for x in out]
`);
  assert.equal(res.ok, true, res.error ?? "run failed");
  assert.match(res.result ?? "", /contents of a\.ts/);
  assert.match(res.result ?? "", /ENOENT: missing\.ts/, "the failure is reported in place");
  assert.match(res.result ?? "", /contents of b\.ts/, "and the call after it still ran");
});

test("an unknown tool in a batch is a ToolError, not a dead kernel", async () => {
  const k = kernel(makeKernelDispatcher([fakeTool("read_file", () => "x")], allow));
  const res = await k.run(`
out = tools.parallel([("read_file", {}), ("nope", {})])
isinstance(out[1], ToolError) and "nope" in str(out[1])
`);
  assert.equal(res.ok, true, res.error ?? "run failed");
  assert.equal(res.result, "True");
  // and the kernel is still usable afterwards
  const after = await k.run(`tools.read_file()`);
  assert.equal(after.ok, true, after.error ?? "run failed");
});

test("a denied tool is refused inside a batch too", async () => {
  // programmatic tool calling must not be a way around the permission rules,
  // and a batch must not be a way around programmatic tool calling's gate
  const perms: Permissions = {
    ...DEFAULT_PERMISSIONS,
    rules: [{ tool: "bash_exec", pattern: "*", action: "deny" },
            ...DEFAULT_PERMISSIONS.rules],
  };
  const tools = [fakeTool("bash_exec", () => "ran"), fakeTool("read_file", () => "read")];
  const k = kernel(makeKernelDispatcher(tools, gateWith(perms)));
  const res = await k.run(`
out = tools.parallel([("read_file", {}), ("bash_exec", {"command": "rm -rf /"})])
(out[0], isinstance(out[1], ToolError))
`);
  assert.equal(res.ok, true, res.error ?? "run failed");
  assert.equal(res.result, `('read', True)`);
});

test("approval prompts are serialized even when the calls are not", async () => {
  // two readline prompts racing for one terminal is how you approve the wrong
  // command; the calls behind them may still overlap
  let inFlight = 0;
  let maxConcurrentGates = 0;
  const gate = async () => {
    inFlight += 1;
    maxConcurrentGates = Math.max(maxConcurrentGates, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight -= 1;
    return {};
  };
  const k = kernel(makeKernelDispatcher([slowTool("read_file", 60, () => "x")], gate));
  const started = Date.now();
  const res = await k.run(`tools.parallel([("read_file", {}) for _ in range(4)])`);
  const elapsed = Date.now() - started;
  assert.equal(res.ok, true, res.error ?? "run failed");
  assert.equal(maxConcurrentGates, 1, "one prompt at a time");
  assert.ok(elapsed < 4 * 60, `execution still overlaps, took ${elapsed}ms`);
});

test("an empty batch costs nothing and a malformed one is caught in python", async () => {
  const k = kernel(makeKernelDispatcher([fakeTool("read_file", () => "x")], allow));
  const empty = await k.run(`tools.parallel([])`);
  assert.equal(empty.ok, true, empty.error ?? "run failed");
  assert.equal(empty.result, "[]");

  // a try/except statement is not an expression, so give the kernel one
  const bad = await k.run(`
def probe():
    try:
        tools.parallel([("", {})])
        return "no error"
    except ToolError as e:
        return str(e)

probe()
`);
  assert.equal(bad.ok, true, bad.error ?? "run failed");
  assert.match(bad.result ?? "", /needs a tool name/);
});

test("the tool description tells the model these capabilities exist", () => {
  // building programmatic and parallel tool calling and not advertising them
  // is the same as not having them: the model only knows what the schema says
  const d = ipyRunTool.description;
  assert.match(d, /tools\.<name>/, "programmatic tool calling must be discoverable");
  assert.match(d, /tools\.parallel/, "so must the batch form");
  assert.match(d, /ToolError/, "and how a failure arrives");
});

test("the dispatcher hands in-kernel calls the kernel's session context (D6)", async () => {
  // A cell calling bash_exec has no pi tool-call loop around it; the session
  // facts the child shell should publish ride on the dispatcher's ctx.
  const seen: unknown[] = [];
  const spy: SeaTool = {
    name: "spy", label: "spy", description: "d",
    parameters: Type.Object({}),
    execute: async (_id, _params, _signal, _onUpdate, ctx) => {
      seen.push(ctx);
      return textResult("ok");
    },
  };
  const dispatch = makeKernelDispatcher(
    [spy], allow, "kernel", () => ({ sessionEnv: { sessionId: "k-sess" } }),
  );
  assert.equal(await dispatch("spy", {}), "ok");
  assert.deepEqual(seen[0], { sessionEnv: { sessionId: "k-sess" } });

  // no provider: the tool still runs, with no ctx
  const bare = makeKernelDispatcher([spy], allow);
  assert.equal(await bare("spy", {}), "ok");
  assert.equal(seen[1], undefined);
});
