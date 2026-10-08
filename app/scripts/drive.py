#!/usr/bin/env python3
"""
Drive the real app in a pseudo-terminal and capture what the screen shows.

  python3 scripts/drive.py OUTDIR [--cols 120 --rows 34] -- STEP...

Each STEP is `wait:<seconds>`, `key:<name>` (enter, esc, tab, down, up, left,
right, ctrl-b, ctrl-c, ctrl-d, pgup, pgdn, or literal text after `text:`), or
`shot:<name>` (the emulated screen as ANSI in OUTDIR/<name>.ansi, for
scripts/snapshot.ts). The command after the steps defaults to the app in this
directory. Needs `pyte` (pip install pyte).
"""
import os, pty, select, sys, time, signal
import pyte

KEYS = {
    "enter": "\r", "esc": "\x1b", "tab": "\t", "down": "\x1b[B", "up": "\x1b[A", "left": "\x1b[D", "right": "\x1b[C",
    "ctrl-b": "\x02", "ctrl-c": "\x03", "ctrl-d": "\x04", "pgup": "\x1b[5~", "pgdn": "\x1b[6~", "shift-tab": "\x1b[Z",
}

def to_ansi(screen):
    out = []
    for y in range(screen.lines):
        row = screen.buffer[y]
        line = []
        for x in range(screen.columns):
            c = row[x]
            codes = ["0"]
            for attr, base in ((c.fg, 38), (c.bg, 48)):
                if attr and attr != "default":
                    if len(attr) == 6 and all(ch in "0123456789abcdefABCDEF" for ch in attr):
                        codes.append(f"{base};2;{int(attr[0:2],16)};{int(attr[2:4],16)};{int(attr[4:6],16)}")
            if c.bold: codes.append("1")
            line.append(f"\x1b[{';'.join(codes)}m{c.data}")
        out.append("".join(line) + "\x1b[0m")
    return "\n".join(out)

def main():
    args = sys.argv[1:]
    outdir = args.pop(0)
    cols, rows = 120, 34
    if "--cols" in args: i = args.index("--cols"); cols = int(args[i+1]); del args[i:i+2]
    if "--rows" in args: i = args.index("--rows"); rows = int(args[i+1]); del args[i:i+2]
    steps, cmd = args, ["bun", "bin/mnemo.ts"]
    if "--" in args: i = args.index("--"); steps, cmd = args[:i], args[i+1:] or cmd
    os.makedirs(outdir, exist_ok=True)
    screen = pyte.Screen(cols, rows)
    stream = pyte.ByteStream(screen)
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update({"TERM": "xterm-256color", "COLORTERM": "truecolor", "COLUMNS": str(cols), "LINES": str(rows)})
        os.execvp(cmd[0], cmd)
    import fcntl, termios, struct
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    def pump(seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if r:
                try: data = os.read(fd, 65536)
                except OSError: return
                stream.feed(data)
    pump(0.3)
    for s in steps:
        kind, _, val = s.partition(":")
        if kind == "wait": pump(float(val))
        elif kind == "key": os.write(fd, KEYS[val].encode()); pump(0.25)
        elif kind == "text": os.write(fd, val.encode()); pump(0.25)
        elif kind == "shot":
            with open(os.path.join(outdir, f"{val}.ansi"), "w") as f: f.write(to_ansi(screen))
            print(os.path.join(outdir, f"{val}.ansi"))
    try: os.kill(pid, signal.SIGTERM)
    except ProcessLookupError: pass

main()
