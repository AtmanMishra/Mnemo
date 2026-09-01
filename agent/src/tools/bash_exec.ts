import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { Type } from "typebox";
import { textResult, type SeaTool } from "./types.ts";
import { approvalGate } from "../approval.ts";
import { scrubChildEnv } from "../childenv.ts";

const parameters = Type.Object({
  command: Type.String({ description: "Shell command to execute (run via /bin/sh -c)" }),
  timeout_ms: Type.Optional(
    Type.Number({ description: "Kill the command after this many milliseconds. Default 120000.", minimum: 1 }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory. Default: workspace root." })),
});

export interface BashDetails {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export async function runBash(
  command: string,
  opts: { timeoutMs?: number; cwd?: string; signal?: AbortSignal } = {},
): Promise<BashDetails> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return await new Promise<BashDetails>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    // Resolve symlinks (e.g. /tmp -> /private/tmp on macOS) so `pwd` matches
    // the requested directory.
    let cwd = opts.cwd;
    if (cwd !== undefined) {
      try { cwd = fs.realpathSync(cwd); } catch { /* let spawn report a bad path */ }
    }

    const child = spawn(command, {
      shell: true,
      cwd,
      signal: opts.signal,
      stdio: ["ignore", "pipe", "pipe"],
      // 12.7: an approved command must not be able to read the provider key
      // (or any other credential) out of our environment
      env: scrubChildEnv(),
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

    const finish = (fn: () => void) => {
      if (!settled) { settled = true; clearTimeout(timer); fn(); }
    };

    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (exitCode) =>
      finish(() => resolve({ stdout, stderr, exitCode, timedOut })),
    );
  });
}

export const bashExecTool: SeaTool = {
  name: "bash_exec",
  label: "Bash exec",
  description:
    "Run a shell command and return stdout, stderr and exit code. " +
    "Non-zero exit codes are reported in the result, not thrown as errors.",
  parameters,
  async execute(_toolCallId, params, signal) {
    const denied = await approvalGate("bash_exec", `$ ${params.command}`);
    if (denied) return textResult(denied);
    const res = await runBash(params.command, {
      timeoutMs: params.timeout_ms,
      cwd: params.cwd,
      signal,
    });
    if (res.timedOut) {
      throw new Error(
        `bash_exec: command timed out after ${params.timeout_ms ?? 120000}ms and was killed.\n` +
          `stdout so far:\n${res.stdout}\nstderr so far:\n${res.stderr}`,
      );
    }
    const parts = [
      res.stdout ? `stdout:\n${res.stdout}` : "stdout: (empty)",
      res.stderr ? `stderr:\n${res.stderr}` : "stderr: (empty)",
      `exit code: ${res.exitCode}`,
    ];
    return textResult(parts.join("\n"), res);
  },
};
