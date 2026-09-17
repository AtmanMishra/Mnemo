#!/usr/bin/env node
/**
 * Regenerate the generated parts of docs/interface-assets.html.
 *
 * The page shows two kinds of thing: what ships today, and what is proposed.
 * Only the first kind may be hand-written, and it may not be hand-COPIED — a
 * preview that says "this is the current glyph set" and was typed from memory
 * is wrong within a commit, and wrong in the way that reads as authoritative.
 *
 * So the current values are read out of tui-go/internal/theme/theme.go and
 * injected between markers. Run it after touching the glyph sets:
 *
 *   node docs/gen-assets.mjs
 *
 * Idempotent: running it twice leaves the file byte-identical.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GO = path.join(root, "tui-go", "internal", "theme", "theme.go");
const HTML = path.join(root, "docs", "interface-assets.html");

const go = fs.readFileSync(GO, "utf8");

/** Read a `var Name = Glyphs{ ... }` block into key → string. */
function glyphSet(name) {
  const block = go.match(new RegExp(`var ${name} = Glyphs\\{([\\s\\S]*?)\\n\\}`));
  if (!block) return null;
  const out = {};
  for (const m of block[1].matchAll(/^\s*(\w+):\s*"(.*?)",/gm)) out[m[1]] = m[2];
  return out;
}

/** Read `var Name = []rune{...}` into a string. */
function runeRamp(name) {
  const block = go.match(new RegExp(`var ${name} = \\[\\]rune\\{([\\s\\S]*?)\\}`));
  if (!block) return null;
  const runes = [...block[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  return runes.length ? runes : null;
}

const HEAVY = glyphSet("Heavy");
const DEFAULT_GLYPHS = glyphSet("Default") ?? HEAVY;
const DITHER = runeRamp("Dither");

if (!HEAVY) {
  console.error("could not find the Heavy glyph set in theme.go — has it been renamed?");
  process.exit(1);
}

const SPEAKERS = [
  ["User", "you"],
  ["Agent", "agent"],
  ["Think", "thinking"],
  ["Tool", "tool"],
];

/** Show each gutter the way the transcript uses it: the glyph, then its name.
 *  Code points are included because two of these look identical in some fonts. */
function gutterBlock(set, label) {
  const rows = SPEAKERS.filter(([k]) => set[k] !== undefined).map(([key, name]) => {
    const g = set[key];
    const cp = [...g]
      .map((ch) => "U+" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"))
      .join(" ");
    return `${g.padEnd(3)}${name.padEnd(11)}${cp}`;
  });
  return `${label}\n\n${rows.join("\n")}`;
}

const ditherLine = DITHER
  ? `ramp:  ${DITHER.join(" ")}   (${DITHER.length} levels, lightest to densest)`
  : "ramp:  not found in theme.go";

const injected = `${gutterBlock(HEAVY, "Heavy — the shipping set:")}\n\n${ditherLine}`;

const html = fs.readFileSync(HTML, "utf8");
const MARK = /(<div class="term" id="current-gutters">)([\s\S]*?)(<\/div>)/;
if (!MARK.test(html)) {
  console.error("could not find the injection point (id=\"current-gutters\") in interface-assets.html");
  process.exit(1);
}
const next = html.replace(MARK, (_m, open, _old, close) => `${open}${injected}${close}`);

if (next === html) {
  // The values were already current. Say so rather than rewriting the file.
  console.log("already current — nothing to write");
} else {
  fs.writeFileSync(HTML, next);
  console.log(`updated ${path.relative(root, HTML)} from ${path.relative(root, GO)}`);
}

// A second check, cheap and worth having: every glyph the page SHOWS as current
// must exist in the Go source, or the page is describing a set that is not there.
const shown = next.match(/<div class="term" id="current-gutters">([\s\S]*?)<\/div>/)[1];
for (const [key] of SPEAKERS) {
  if (HEAVY[key] && !shown.includes(HEAVY[key])) {
    console.error(`the page does not show ${key}'s glyph (${HEAVY[key]}) — injection is stale`);
    process.exit(1);
  }
}
console.log(`checked ${SPEAKERS.length} gutters against ${path.basename(GO)}`);
