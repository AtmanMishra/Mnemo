/**
 * Drives the binary inside a real pseudo-terminal, the way a person at a keyboard
 * does: the interactive interface, dialogs, keys. Python's `pty` module is the
 * terminal (Linux and macOS; Windows has no `pty`, so these tests skip there).
 *
 *   const t = await terminal(world, ["--no-boot"]);
 *   await t.waitFor(/Ask Mnemo/);
 *   t.type("/login anthropic\r");
 *   await t.waitFor(/how do you want to log in/);
 */
import * as path from "node:path";
import { binary, type World } from "./harness.ts";

// A bridge: everything on our stdin goes to the terminal, everything the terminal
// prints comes back on stdout. The window is fixed so frames are comparable.
const BRIDGE = String.raw`
import os, pty, sys, select, struct, fcntl, termios, signal
cols, rows = int(sys.argv[1]), int(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[3], sys.argv[3:], os.environ)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
inp = sys.stdin.fileno()
while True:
    r, _, _ = select.select([fd, inp], [], [], 0.05)
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if inp in r:
        data = os.read(inp, 4096)
        if not data:
            os.kill(pid, signal.SIGTERM)
            break
        os.write(fd, data)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else 0)
`;

export const hasPty = process.platform !== "win32" && !!(Bun.which("python3") ?? Bun.which("python"));

/** The screen as text: escape sequences out, so tests match words, not colours. */
export function plain(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/\x1b[()][0-9A-B]/g, "")
    .replace(/\x1b[=>78]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export interface Terminal {
  /** Everything printed so far, as plain text. */
  text(): string;
  /** Everything printed so far, escape sequences included. */
  raw(): string;
  /** Types like a person: one key at a time (a burst would read as a paste). An escape sequence is one key. */
  type(keys: string): Promise<void>;
  /** Resolves when the screen (since `since`) matches; fails with the screen when it does not. */
  waitFor(re: RegExp, timeoutMs?: number): Promise<void>;
  /** Marks the current end of output, so the next waitFor only looks at what comes after. */
  mark(): void;
  kill(): Promise<number>;
  /** The exit code, once the program leaves on its own; undefined if still running after `ms`. */
  exitWithin(ms: number): Promise<number | undefined>;
}

export const KEY = { enter: "\r", esc: "\x1b", ctrlC: "\x03", ctrlD: "\x04", ctrlK: "\x0b", ctrlF: "\x06", down: "\x1b[B", up: "\x1b[A", tab: "\t" };

export async function terminal(w: World, args: string[], opts: { cols?: number; rows?: number; env?: Record<string, string> } = {}): Promise<Terminal> {
  const python = Bun.which("python3") ?? Bun.which("python")!;
  const p = Bun.spawn([python, "-c", BRIDGE, String(opts.cols ?? 120), String(opts.rows ?? 40), binary(), ...args], {
    cwd: w.project,
    env: { ...w.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...opts.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let raw = "";
  let from = 0;
  void (async () => {
    const dec = new TextDecoder();
    for await (const c of p.stdout as unknown as AsyncIterable<Uint8Array>) raw += dec.decode(c, { stream: true });
  })();
  const t: Terminal = {
    text: () => plain(raw),
    raw: () => raw,
    type: async (keys) => {
      const parts = keys.startsWith("\x1b") ? [keys] : [...keys];
      for (const k of parts) {
        p.stdin.write(k);
        p.stdin.flush();
        await Bun.sleep(15);
      }
    },
    mark: () => {
      from = raw.length;
    },
    waitFor: async (re, timeoutMs = 20_000) => {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (re.test(plain(raw.slice(from)))) return;
        if (p.exitCode !== null) break;
        await Bun.sleep(50);
      }
      const screen = plain(raw.slice(from)).replace(/ {2,}/g, " ").slice(-3000);
      throw new Error(`terminal never showed ${re} (exit ${p.exitCode})\n--- screen ---\n${screen}`);
    },
    kill: async () => {
      p.kill();
      return p.exited;
    },
    exitWithin: (ms) => Promise.race([p.exited, Bun.sleep(ms).then(() => undefined)]),
  };
  return t;
}

export const here = path.dirname(import.meta.path);
