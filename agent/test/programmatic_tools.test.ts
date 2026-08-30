/**
 * 4.6 + 4.7: programmatic tool calling. The kernel here is a real python3
 * process running the real bridge; only the tools are fakes.
 */
import { test, after } from "node:test";
import assert from "node:assert";
import { IPyKernel } from "../src/tools/ipy_run.ts";
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
  assert.equal(res.ok, true, res.error);
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
  assert.equal(res.ok, true, res.error);
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
  assert.equal(res.ok, true, res.error);
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
  assert.equal(res.ok, true, res.error);
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
  assert.equal(res.ok, true, res.error);
  assert.match(res.result ?? "", /denied by/);
  assert.equal(ran, 0, "the denied tool must not have executed");

  // the same tool with an allowed command still works
  const ok = await k.run(`tools.bash_exec(command="ls")`);
  assert.equal(ok.ok, true, ok.error);
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
