#!/usr/bin/env python3
"""JSON-lines stdio bridge for the sea-agent ipy_run tool.

Protocol (one JSON object per line, UTF-8):
  request : {"id": <int>, "op": "run",    "code": "<python source>"}
            {"id": <int>, "op": "ping"}

Programmatic tool calling (plan 4.6): submitted code can call host tools as
`tools.read_file(path="x")`. That writes an out-of-band line UP the same pipe
  {"op": "tool_call", "name": "<tool>", "args": {...}}
and blocks on the host's reply
  {"op": "tool_result", "ok": true, "result": <json>}   (or ok:false + error)

Two things make that safe: the request is written to the stdout buffer captured
BEFORE contextlib.redirect_stdout, so it is not swallowed by the cell's output
capture; and the reply is read from the same stdin object the main loop uses,
which is idle because it is blocked inside this very call.
  response: {"id": <int>, "ok": true,  "result": "<repr of last expr>",
             "output": "<captured stdout+stderr>"}
            {"id": <int>, "ok": false, "error": "<traceback text>",
             "output": "<captured stdout+stderr produced before failure>"}

The kernel namespace persists for the lifetime of this process, so variables,
imports and definitions survive across calls - exactly like a notebook kernel.
Messages are handled strictly sequentially in arrival order. The process never
exits on a user-code exception; only a fatal interpreter error ends it.
"""

import ast
import contextlib
import io
import json
import sys
import traceback


class ToolError(RuntimeError):
    """A host tool refused or failed. Catchable by the submitted program."""


class ToolProxy:
    """`tools.<name>(**kwargs)` -> one host tool call, synchronously."""

    def __init__(self, stdin, stdout) -> None:
        object.__setattr__(self, "_stdin", stdin)
        object.__setattr__(self, "_stdout", stdout)

    def __getattr__(self, name: str):
        # dunder/private lookups are Python internals (repr, pickle, help),
        # never tool calls - answering them with a callable breaks introspection
        if name.startswith("_"):
            raise AttributeError(name)

        def call(**kwargs):
            request = {"op": "tool_call", "name": name, "args": kwargs}
            stdout = object.__getattribute__(self, "_stdout")
            stdin = object.__getattribute__(self, "_stdin")
            stdout.write((json.dumps(request) + "\n").encode("utf-8"))
            stdout.flush()
            line = stdin.readline()
            if not line:
                raise ToolError(f"bridge closed while calling {name}")
            try:
                reply = json.loads(line.decode("utf-8"))
            except Exception as exc:
                raise ToolError(f"unreadable reply for {name}: {exc}") from None
            if not reply.get("ok"):
                raise ToolError(reply.get("error") or f"tool {name} failed")
            return reply.get("result")

        call.__name__ = name
        return call


class SeaKernel:
    def __init__(self, stdin=None, stdout=None) -> None:
        self.globals: dict = {"__name__": "__sea_kernel__", "__builtins__": __builtins__}
        # tools are only reachable when the host wired up a pipe for them
        if stdin is not None and stdout is not None:
            self.globals["tools"] = ToolProxy(stdin, stdout)
            self.globals["ToolError"] = ToolError

    def run(self, code: str) -> dict:
        stdout_buf = io.StringIO()
        stderr_buf = io.StringIO()

        try:
            tree = ast.parse(code)
        except (SyntaxError, ValueError) as exc:
            error = "".join(traceback.format_exception_only(type(exc), exc)).rstrip("\n")
            if exc.text:
                error += "\n" + exc.text.rstrip("\n")
            return {"ok": False, "error": f"SyntaxError in submitted code:\n{error}", "output": ""}

        body = list(tree.body)
        last_expr = None
        if body and isinstance(body[-1], ast.Expr):
            last_expr = body[-1]
            body = body[:-1]

        module_code = compile(ast.Module(body=body, type_ignores=[]), "<sea_kernel>", "exec") if body else None
        expr_code = compile(ast.Expression(last_expr.value), "<sea_kernel>", "eval") if last_expr else None

        result_repr = None
        try:
            with contextlib.redirect_stdout(stdout_buf), contextlib.redirect_stderr(stderr_buf):
                if module_code is not None:
                    exec(module_code, self.globals)
                if expr_code is not None:
                    value = eval(expr_code, self.globals)
                    if value is not None:
                        # Keep the repr even if user code replaced __builtins__ helpers.
                        result_repr = repr(value)
        except BaseException:  # noqa: BLE001 - report everything to the caller
            error = traceback.format_exc().rstrip("\n")
            output = stdout_buf.getvalue() + stderr_buf.getvalue()
            return {"ok": False, "error": error, "output": output}

        output = stdout_buf.getvalue() + stderr_buf.getvalue()
        return {"ok": True, "result": result_repr, "output": output}


def handle(kernel: SeaKernel, request: dict) -> dict:
    op = request.get("op", "run")
    response = {"id": request.get("id")}
    if op == "ping":
        response.update(ok=True, result="pong", output="")
    elif op == "reset":
        kernel.__init__()  # type: ignore[func-returns-value]  # clears namespace in place
        response.update(ok=True, result="namespace cleared", output="")
    else:
        code = request.get("code", "")
        response.update(kernel.run(code))
    return response


def main() -> None:
    # Unbuffered binary wrappers so partial writes are visible immediately.
    # Captured BEFORE any redirect_stdout, which is what lets a tool_call
    # escape the cell's output capture.
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    kernel = SeaKernel(stdin, stdout)

    # explicit readline() rather than `for line in stdin`: the tools proxy
    # reads replies from this same object mid-call, and one obvious buffer is
    # easier to reason about than an iterator's read-ahead
    while True:
        line = stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line.decode("utf-8"))
        except Exception:
            response = {"id": None, "ok": False, "error": "unparseable request line", "output": ""}
        else:
            try:
                response = handle(kernel, request)
            except Exception:
                response = {
                    "id": request.get("id") if isinstance(request, dict) else None,
                    "ok": False,
                    "error": traceback.format_exc(),
                    "output": "",
                }
        stdout.write((json.dumps(response) + "\n").encode("utf-8"))
        stdout.flush()


if __name__ == "__main__":
    main()
