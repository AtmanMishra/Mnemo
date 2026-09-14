# Programmatic Tool Calling (Mnemo) — design v0
Corresponds to plan.md tasks 4.6 and 4.7. Extends the persistent kernel
bridge to let generated Python code invoke tools as ordinary functions instead
of surfacing tool-calls to the model's next decision loop.

## 1. Why
The standard agentic loop emits one tool_use block per decision; the harness
runs it and the FULL result (exit code, stdout, file diff) re-enters the model's
context before the next tool can be chosen. N tool calls = N model round trips.
Every intermediate result burns context tokens and adds latency.

Programmatic tool calling has the model write ONE program that calls tools as
ordinary functions. Loops, filters, and joins happen inside the sandbox. Only
the final value returns to context.

Worked example: filter a glob_list result by reading each matched file and
returning only the first ten that pass a pattern.

```python
# Programmatic (1 round trip total):
matches = tools.glob_list(pattern="*.py")
results = []
for path in matches:
    content = tools.read_file(path=path)
    if "TODO" in content:
        results.append(path)
    if len(results) == 10:
        break
results
```

The same work as standard tool-calls: one glob_list, then one read_file round
trip per candidate file. Over 40 candidates that is 41 round trips, and all 40
file bodies sit in context even though 30 of them were discarded. The loop
above costs one round trip and returns ten paths.

## 2. What already exists

| Piece | Where | Status |
|-------|-------|--------|
| Persistent sandbox with state across calls | agent/kernel/ipy_bridge.py + ipy_run tool | exists (JSON-lines stdio, {id, op:"run", code} → {id, ok, result, output}, namespace persists like a notebook) |
| Uniform callable tool contract | agent/src/tools/types.ts SeaTool.execute(toolCallId, params, signal?, onUpdate?) with TypeBox schema | exists (11 tools in allTools registry) |
| Precedent for tools-as-generated-code | harness-engine bundles (manifest.json + .mjs written at runtime) | exists |
| Tools reachable from INSIDE the kernel | nothing | MISSING — this is the entire work of 4.6 |

## 3. Mechanics
The missing piece is one extra message type on a channel that already exists.
No new process or dependency.

**Python side:** A `tools` proxy object in the kernel globals. `tools.read_file(path="x")`
serializes `{"op":"tool_call","name":...,"args":...}` and blocks waiting for a
reply line. The result is unpacked and returned as a Python value.

**Node side:** IPyKernel already reads the kernel's stdout stream
(handleStdoutChunk). Add a branch for `op == "tool_call"` that dispatches into
allTools, awaits the result, and writes it back down the same pipe.

**Rough size:** ~40 lines on each side.

**THE GOTCHA:** SeaKernel.run() redirects stdout to capture the
user code's output (line 53 of ipy_bridge.py: `contextlib.redirect_stdout(stdout_buf)`).
The tool-call request MUST be written to `sys.__stdout__` (the unredirected stream)
or it will be swallowed by the capture buffer. The reply is read from `sys.stdin`,
which is safe ONLY because the bridge's main loop is blocked inside run() and is not
reading concurrently. Getting this wrong deadlocks or interleaves the protocol.

**Result delivery:** Tool results are returned to the program as Python values
(deserialized from JSON), not as text pasted into context. Only what the
program's last expression evaluates to goes back to the model.

## 4. Security (task 4.7)
The approval-gate extension currently prompts y/n on bash_exec, write_file,
and apply_edit (agent/extensions/approval-gate.ts, GATED_TOOLS set). Under
programmatic tool calling those calls happen inside generated code, so the
gate is bypassed unless in-kernel dispatch routes through the same gate AND
the 4.3 permission rules later.

**Gotcha:** a single program can make many mutating calls in sequence. Per-call
approval may be noisy or defeat the purpose. Per-program approval (approve
once, let the program run) is simpler but requires showing the user the program's
intent before they approve — which is non-trivial if the program is generated.

Design this before building the rest.

## 5. Why it fits Mnemo
This is harness-side, so it is provider-agnostic. It needs no special API
support and works on the free OpenAI-compatible models Mnemo already runs on
(any model that can write Python gets it). That matches the project thesis:
small models plus better scaffolding beat raw scale, rather than depending on
a vendor feature.

## 6. Implementation path
**P1:** tool_call op on the bridge + `tools` proxy in the kernel namespace (4.6)
- Add op == "tool_call" branch in IPyKernel.handleStdoutChunk
- Dispatch into allTools, capture result, write JSON reply back to stdin
- Add `tools` ToolsProxy object to SeaKernel.globals before accepting code
- ToolsProxy.__getattr__ returns a callable that serializes + blocks on reply

**P2:** route in-kernel dispatch through the approval gate (4.7)
- Decide whether to gate per-call or per-program
- If per-call: wrap tool dispatch in decideApproval before executing
- If per-program: add a "show me the program first" flow before run()

**P3:** measure and iterate (post-impl)
- Decide per-call vs per-program approval once there is something to try
- Benchmark context saved vs round-trip latency on a fixed eval suite

Note: no new tool is needed. ipy_run simply gains `tools` in scope.

## 7. Open questions
**Q1:** Per-call approval or per-program approval, and how is a program's
intent shown to the user before they approve it? (If per-call: does re-prompt
fatigue defeat the feature?) `summarizeToolCall` in approval-gate.ts already
renders one call for a human; whether the same idea extends to a whole
generated program is the open part.

**Q2:** How do tool errors surface? Do errors become Python exceptions the
program can catch, or does an immediate error abort the program and return
the traceback to the model?

**Q3:** Is the win measurable on the memory eval? Should benchmarking
round-trip count and context bytes saved become an Area 7 eval case?
