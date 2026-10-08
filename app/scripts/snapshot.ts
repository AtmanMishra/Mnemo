#!/usr/bin/env bun
/**
 * A terminal frame as a picture, for looking at the interface while
 * designing it: ANSI (truecolor) on stdin → a grid of cells → an SVG where
 * block characters are drawn as exact rectangles (a browser font leaves gaps
 * between half blocks, which garbles pixel art) → a PNG via headless Chromium.
 *
 *   FORCE_COLOR=3 bun bin/mnemo.ts --demo --dump | bun scripts/snapshot.ts out.png
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

interface Cell {
  ch: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
}

const GROUND = "#0E0B16";
const TEXT = "#EDE4D3";
const CW = 9;
const CH = 18;

function parse(ansi: string): Cell[][] {
  const rows: Cell[][] = [];
  let fg: string | undefined;
  let bg: string | undefined;
  let bold = false;
  let dim = false;
  for (const line of ansi.replace(/\r/g, "").split("\n")) {
    const row: Cell[] = [];
    for (let i = 0; i < line.length; ) {
      if (line[i] === "\x1b") {
        const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(line.slice(i));
        if (!m) {
          i++;
          continue;
        }
        i += m[0].length;
        if (m[2] !== "m") continue;
        const codes = m[1] === "" ? [0] : m[1]!.split(";").map(Number);
        for (let k = 0; k < codes.length; k++) {
          const c = codes[k]!;
          if (c === 0) [fg, bg, bold, dim] = [undefined, undefined, false, false];
          else if (c === 1) bold = true;
          else if (c === 2) dim = true;
          else if (c === 22) [bold, dim] = [false, false];
          else if (c === 39) fg = undefined;
          else if (c === 49) bg = undefined;
          else if ((c === 38 || c === 48) && codes[k + 1] === 2) {
            const hex = `#${[codes[k + 2], codes[k + 3], codes[k + 4]].map((v) => (v ?? 0).toString(16).padStart(2, "0")).join("")}`;
            if (c === 38) fg = hex;
            else bg = hex;
            k += 4;
          } else if ((c === 38 || c === 48) && codes[k + 1] === 5) k += 2;
        }
        continue;
      }
      const cp = line.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      i += ch.length;
      row.push({ ch, fg, bg, bold, dim });
    }
    rows.push(row);
  }
  while (rows.length && rows.at(-1)!.length === 0) rows.pop();
  return rows;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function svg(rows: Cell[][]): string {
  const cols = Math.max(20, ...rows.map((r) => r.length));
  const w = cols * CW;
  const h = rows.length * CH;
  const parts: string[] = [`<rect width="${w}" height="${h}" fill="${GROUND}"/>`];
  rows.forEach((row, y) =>
    row.forEach((c, x) => {
      const X = x * CW;
      const Y = y * CH;
      const fg = c.fg ?? TEXT;
      if (c.bg) parts.push(`<rect x="${X}" y="${Y}" width="${CW}" height="${CH}" fill="${c.bg}"/>`);
      const rect = (dx: number, dy: number, rw: number, rh: number, op = 1) =>
        parts.push(`<rect x="${X + dx}" y="${Y + dy}" width="${rw}" height="${rh}" fill="${fg}"${op < 1 ? ` fill-opacity="${op}"` : ""}/>`);
      switch (c.ch) {
        case " ":
          return;
        case "█":
          return rect(0, 0, CW, CH);
        case "▀":
          return rect(0, 0, CW, CH / 2);
        case "▄":
          return rect(0, CH / 2, CW, CH / 2);
        case "▌":
          return rect(0, 0, Math.ceil(CW / 2), CH);
        case "▐":
          return rect(Math.floor(CW / 2), 0, Math.ceil(CW / 2), CH);
        case "░":
          return rect(0, 0, CW, CH, 0.25);
        case "▒":
          return rect(0, 0, CW, CH, 0.5);
        case "▓":
          return rect(0, 0, CW, CH, 0.75);
        case "▖":
          return rect(0, CH / 2, CW / 2, CH / 2);
        case "▘":
          return rect(0, 0, CW / 2, CH / 2);
        case "▝":
          return rect(CW / 2, 0, CW / 2, CH / 2);
        case "▗":
          return rect(CW / 2, CH / 2, CW / 2, CH / 2);
        default:
          parts.push(
            `<text x="${X}" y="${Y + CH * 0.78}" fill="${fg}"${c.bold ? ' font-weight="bold"' : ""}${c.dim ? ' fill-opacity="0.6"' : ""}>${esc(c.ch)}</text>`,
          );
      }
    }),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" font-family="DejaVu Sans Mono, monospace" font-size="15">${parts.join("")}</svg>`;
}

const out = path.resolve(process.argv[2] ?? "snapshot.png");
const rows = parse(await Bun.stdin.text());
const doc = svg(rows);
const file = out.replace(/\.png$/, ".html");
// Inline in a zero-margin page: Chrome sizes a bare SVG document unreliably.
fs.writeFileSync(file, `<!doctype html><html><body style="margin:0;background:${GROUND}">${doc}</body></html>`);
const w = Number(/width="(\d+)"/.exec(doc)![1]);
const h = Number(/height="(\d+)"/.exec(doc)![1]);
const root = "/opt/pw-browsers";
const dir = fs.existsSync(root) ? fs.readdirSync(root).find((d) => d.startsWith("chromium-")) : undefined;
const exe = dir ? path.join(root, dir, "chrome-linux", "chrome") : "chromium";
const r = spawnSync(exe, ["--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", `--window-size=${w},${h + 160}`, `--screenshot=${out}`, `file://${file}`], { encoding: "utf8" });
if (r.status !== 0 || !fs.existsSync(out)) {
  console.error(r.stderr || r.stdout || `no screenshot from ${exe}`);
  process.exit(1);
}
console.log(out);
