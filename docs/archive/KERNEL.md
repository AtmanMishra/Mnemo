# The Python Kernel and Programmatic Tool Calling


> **On citations.** This document names files, not line numbers. The repo is
> under active development and spans go stale within hours — an earlier draft
> of these docs cited `tui/src/agent_main.rs` lines that had already moved by
> the time it was written. For an exact span, ask the code:
> `graft ask "<question>" --source`, or `graft skeleton <file>`.

`ipy_run` is Mnemo's most structurally unusual tool: instead of the model
issuing one `tool_use` block per action, it can submit a whole Python
program to a persistent interpreter, and that program can call *other*
Mnemo tools from inside itself — synchronously, in a loop, or as one batched
parallel call. This document covers the two halves of that: the host-side
`IPyKernel` client (`agent/src/tools/ipy_run.ts`) and the kernel process
itself (`agent/kernel/ipy_bridge.py`), plus how `spawn_subagent` builds on
the same shared-memory-journal idea to spawn a hierarchical, optionally
differently-modelled child agent.

## Why this exists

A tool call is normally one round trip: the model emits a `tool_use` block,
the host executes it, the result goes back into context, and the model has
to decide what to do next only after seeing that one result. A loop over
forty files — read each one, check something, maybe skip — is forty round
trips through the model, each one paying for the whole conversation history
again. `ipy_run` lets the model write the loop once, in Python, and have it
run to completion (or to the first `ToolError`) without a model round trip
per iteration. The persistent kernel means the model can build up state
incrementally across several `ipy_run` calls too, the way a human uses a
notebook.

## The protocol

`agent/kernel/ipy_bridge.py`'s module docstring
(`agent/kernel/ipy_bridge.py`) is the authoritative protocol spec; the
essentials:

- One JSON object per line on stdin/stdout.
- `{"id": N, "op": "run", "code": "<python>"}` executes; the reply is
  `{"id": N, "ok": true, "result": "<repr of last expression>", "output":
  "<captured stdout+stderr>"}` or `{"ok": false, "error": "<traceback>",
  "output": "..."}`.
- `{"id": N, "op": "ping"}` / `{"op": "reset"}` are housekeeping (health
  check; clear the namespace).
- From *inside* running code, `tools.<name>(**kwargs)` sends an **out of
  band** line up the same pipe — `{"op": "tool_call", "name": ..., "args":
  ...}` — and blocks on a reply, `{"op": "tool_result", "ok": ..., "result":
  ... | "error": ...}`. `tools.parallel([...])` does the same with
  `{"op": "tool_calls", "calls": [...]}` and gets back `results: [...]` in
  the original order.

The kernel namespace persists for the process's lifetime — imports,
functions, variables all survive across `ipy_run` calls, "exactly like a
notebook kernel" (`agent/kernel/ipy_bridge.py`).

### Why the tool-call channel is safe from output capture

This is the one piece of the protocol worth quoting directly, because it is
easy to get wrong: `SeaKernel.run()` wraps the submitted code in
`contextlib.redirect_stdout`/`redirect_stderr` so a cell's `print()` calls
are captured into the `output` field instead of corrupting the JSONL stream
(`agent/kernel/ipy_bridge.py`). But `ToolProxy._rpc` needs to write a
*protocol* line to the real stdout and read a reply from the real stdin —
if it used the redirected stream, its request would be silently captured as
"output" instead of reaching the host. The fix is that `ToolProxy` is
constructed with the raw, pre-redirect file objects, captured once at
process startup before any redirection happens
(`agent/kernel/ipy_bridge.py`, `_rpc` at
`agent/kernel/ipy_bridge.py`). The reply is read with `stdin.readline()`
on that same object the main loop's `while True: line = stdin.readline()`
uses — safe specifically because the main loop is *blocked inside this very
call* and cannot also be reading (`agent/kernel/ipy_bridge.py,200-202`).

## Host side: `IPyKernel`

`agent/src/tools/ipy_run.ts`'s `IPyKernel` class owns one lazily-spawned
`python3 -u agent/kernel/ipy_bridge.py` child (`start()`,
`agent/src/tools/ipy_run.ts`), confirmed alive with a ping/pong
handshake before any `run()` call is allowed through
(`agent/src/tools/ipy_run.ts`). Calls are serialized through a
promise chain (`agent/src/tools/ipy_run.ts`) — concurrent `ipy_run`
tool calls from the model execute strictly in submission order, matching
notebook semantics. A cell that hangs past its `timeout_ms` (default
120,000) is killed and the kernel is dropped; the *next* call transparently
respawns a fresh one, with a fresh (empty) namespace
(`agent/src/tools/ipy_run.ts`).

### `setToolDispatcher`: how `tools.<name>()` reaches real tools

`IPyKernel.setToolDispatcher(fn)` installs the function that answers
in-kernel tool calls (`agent/src/tools/ipy_run.ts`). It is wired once,
at extension load time, in `sea-tools-inline.ts`:

```ts
const perms = loadPermissions();
sharedKernel.setToolDispatcher(
  makeKernelDispatcher(tools, (name, args) =>
    decideApproval({ toolName: name, input: args },
      { confirm: async () => true }, process.env, false, perms)),
);
```
(`agent/extensions/sea-tools-inline.ts`)

The load-bearing point here — stated directly in `kernel_tools.ts`'s doc
comment — is that this is the **same** `decideApproval` gate a normal
top-level tool call goes through (`agent/src/tools/kernel_tools.ts`).
Without that, `ipy_run` would be a way to shell out via `tools.bash_exec()`
without ever hitting the permission engine or the approval prompt. A `deny`
rule still blocks the call; only the *interactive prompt* itself cannot
fire from inside the kernel (there is no `ctx.ui` reachable from here), so
an `ask` action resolves to allow — the same behavior a non-TTY run gets at
the top level (`agent/src/tools/kernel_tools.ts`, the `confirm: async
() => true` stub).

`makeKernelDispatcher` also serializes the *approval decision itself* across
concurrent calls, even when the underlying tool calls run in parallel — "two
readline prompts racing for the same terminal is how you approve the wrong
command" (`agent/src/tools/kernel_tools.ts`).

### Batching: `runBatch` and the parallel-call cap

When the kernel emits `{"op": "tool_calls", "calls": [...]}`, the host runs
them concurrently in bounded waves of `MAX_PARALLEL_TOOL_CALLS = 8`
(`agent/src/tools/ipy_run.ts,115-131`) — "the point of a batch is that N
calls cost one round trip instead of N, so they run at the same time — but
not ALL at the same time: a hundred parallel `bash_exec` calls would be a
fork bomb wearing a tool name" (`agent/src/tools/ipy_run.ts`). Each
element's failure is caught and returned as `{ok: false, error: ...}` in
place rather than rejecting the whole batch, so one bad file among forty
does not lose the other thirty-nine
(`agent/src/tools/ipy_run.ts`, mirrored on the Python side at
`agent/kernel/ipy_bridge.py`).

## Sequence: programmatic and parallel tool calling

```mermaid
sequenceDiagram
    participant Model as LLM
    participant Agent as agent process (Node)
    participant Kernel as ipy_bridge.py (Python)

    Model->>Agent: tool_use ipy_run(code="for p in paths: ...")
    Agent->>Kernel: {"id":7,"op":"run","code":"..."} (stdin)

    Note over Kernel: exec() runs inside<br/>redirect_stdout/stderr

    loop for each path in code
        Kernel->>Agent: {"op":"tool_call","name":"read_file","args":{"path":p}} (stdout, out-of-band)
        Agent->>Agent: makeKernelDispatcher: decideApproval() then tool.execute()
        Agent-->>Kernel: {"op":"tool_result","ok":true,"result":"&lt;file text&gt;"} (stdin)
    end

    Kernel-->>Agent: {"id":7,"ok":true,"result":"&lt;repr&gt;","output":"&lt;captured prints&gt;"}
    Agent-->>Model: tool_execution_end (formatted result)
```

And the batched form, which is what `tools.parallel([...])` produces —
one out-of-band line instead of N:

```mermaid
sequenceDiagram
    participant Model as LLM
    participant Agent as agent process (Node)
    participant Kernel as ipy_bridge.py (Python)

    Model->>Agent: tool_use ipy_run(code="tools.parallel([(read_file,{path:p}) for p in paths])")
    Agent->>Kernel: {"id":8,"op":"run","code":"..."}
    Kernel->>Agent: {"op":"tool_calls","calls":[{"name":"read_file","args":{...}}, ...N]}

    Note over Agent: runBatch(): waves of up to<br/>MAX_PARALLEL_TOOL_CALLS = 8,<br/>run concurrently via Promise.all

    par wave 1 (up to 8 calls)
        Agent->>Agent: decideApproval + tool.execute for each
    end
    Agent-->>Kernel: {"op":"tool_result","ok":true,"results":[{ok,result|error}, ...N]} (order preserved)

    Kernel-->>Agent: {"id":8,"ok":true,"result":"&lt;repr&gt;","output":"..."}
    Agent-->>Model: tool_execution_end
```

A failed element inside that `results` array is a Python `ToolError` object
in the list, not an exception — the submitted code can
`isinstance(r, ToolError)` on each element and keep going
(`agent/kernel/ipy_bridge.py,103-111`).

## Spawning a sub-agent

`spawn_subagent` (`agent/src/tools/subagent.ts`) is a different
mechanism from `ipy_run` — it spawns a *complete second `mnemo.ts` process*
in one-shot ("print") mode, not a persistent bridge — but it belongs in this
document because it is the other place Mnemo composes independent processes
into one hierarchical unit of work, and because it shares the memory graph
the same way the kernel shares Python state.

Key properties of `runSubagent` (`agent/src/tools/subagent.ts`):

- The child command is `node <mnemo.ts> "<composed prompt>"`
  (`agent/src/tools/subagent.ts`), where the composed prompt
  (`composeChildPrompt`, `agent/src/tools/subagent.ts`) is built from
  the parent-supplied `task` plus an optional `context` brief — **not** the
  parent's transcript. "Children never inherit the parent transcript... The
  brief is what the parent CHOOSES to pass" (`agent/src/tools/subagent.ts`).
- `env: { ...process.env, ...childTraceEnv(), ...(opts.env ?? {}) }`
  (`agent/src/tools/subagent.ts`) is what makes this hierarchical rather
  than isolated: `process.env` already carries `MNEMO_MEMORY_JOURNAL` (or its
  default resolves to the same file), so the child's memsrv instance opens
  the *same* journal — the graph is genuinely a shared bus, not a copy.
  `childTraceEnv()` adds the two trace env vars so the child's spans nest
  under the call that spawned it (`docs/DATAFLOW.md`, "Trace-span tree
  across processes").
- A hard timeout (`timeoutMs`, default 300,000ms) `SIGKILL`s the child if it
  runs too long (`agent/src/tools/subagent.ts`).
- The child is expected to end its own reply with a line starting
  `ANSWER:`; `extractAnswer` pulls the last such line out of the child's
  stdout, falling back to the whole trimmed output if the child never
  produced one (`agent/src/tools/subagent.ts`).

### Running a sub-agent on a different model

`resolveModelEnv` (`agent/src/tools/subagent.ts`) is what lets one
sub-agent call run on `claude-opus-5` while the parent runs on a cheaper
model, or vice versa. The `model` parameter accepts a bare model id or
`provider/model`; it is checked against `availableModels()` — every model a
*logged-in* provider actually offers (`agent/src/tools/subagent.ts`,
reading `~/.mnemo/auth.json` via `loadAuth()`). Omitting `model` sets no
override env, which means the child inherits the parent's `MNEMO_PROVIDER`/
`MNEMO_MODEL` exactly as `process.env` already has them — "the common case
and must stay free" (`agent/src/tools/subagent.ts`). Requesting a
model that is not logged in raises immediately with the list of what *is*
available, rather than silently falling back to the parent's model, which
the doc comment calls out explicitly as something that "would look like it
worked" if allowed (`agent/src/tools/subagent.ts`).

```mermaid
sequenceDiagram
    participant Model as parent LLM (e.g. ox-alpha-free)
    participant Parent as parent agent process
    participant Child as child agent process<br/>(node mnemo.ts, print mode)
    participant ChildModel as child's LLM (e.g. claude-opus-5)
    participant Mem as memsrv (shared journal)

    Model->>Parent: tool_use spawn_subagent(task, context, model="claude-opus-5")
    Parent->>Parent: resolveModelEnv("claude-opus-5", availableModels())
    Note over Parent: raises if that model's provider<br/>is not logged in (~/.mnemo/auth.json)

    Parent->>Child: spawn node mnemo.ts "&lt;composed prompt&gt;"<br/>env: MNEMO_PROVIDER/MNEMO_MODEL overridden,<br/>MNEMO_MEMORY_JOURNAL inherited,<br/>MNEMO_TRACE_PARENT_SESSION/SPAN set

    Child->>Child: ensureAuthenticated() sees MNEMO_PROVIDER/MODEL already set
    Child->>ChildModel: runs its own full agent loop (tools, hooks, memory)
    Child->>Mem: memory_write_fact / commit_log (SAME journal file)
    ChildModel-->>Child: assistant text ending "ANSWER: ..."
    Child-->>Parent: stdout (captured), process exits

    Parent->>Parent: extractAnswer(stdout)
    Parent-->>Model: tool_execution_end: "&lt;answer&gt;\n(sub-agent finished in Ns, exit=0)"

    Note over Mem: parent's NEXT memory_search can<br/>retrieve what the child just wrote
```

The last note matters: because the child wrote through the same memsrv
sidecar (its own instance, but the same journal file, under the advisory
lock described in `docs/ARCHITECTURE.md`), anything it learned via
`memory_write_fact` or logged via tool execution is visible to the parent's
*next* `memory_search` — the graph, not the return value, is described in
the tool's own docstring as "the bus"
(`agent/src/tools/subagent.ts`, `agent/src/tools/subagent.ts`).

## Open threads

- `ipy_run`'s tool-call channel has no per-call timeout on the host side —
  a `ponytail:` comment in `ipy_run.ts` notes this directly: "a tool that
  never returns hangs the kernel, the same way it would hang a normal tool
  call. Add one if that ever bites"
  (`agent/src/tools/ipy_run.ts`).
- `spawn_subagent` has no depth limit; a sub-agent that itself calls
  `spawn_subagent` will keep nesting processes (and trace spans) with
  nothing in this codebase capping it beyond the per-call `timeout_ms`.
