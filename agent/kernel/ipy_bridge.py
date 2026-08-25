#!/usr/bin/env python3
"""JSON-lines stdio bridge for the sea-agent ipy_run tool.

Protocol (one JSON object per line, UTF-8):
  request : {"id": <int>, "op": "run",    "code": "<python source>"}
            {"id": <int>, "op": "ping"}
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


class SeaKernel:
    def __init__(self) -> None:
        self.globals: dict = {"__name__": "__sea_kernel__", "__builtins__": __builtins__}

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
    kernel = SeaKernel()
    # Unbuffered binary wrappers so partial writes are visible immediately.
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer

    for line in stdin:
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
