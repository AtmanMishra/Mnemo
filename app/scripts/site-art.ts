/**
 * The site's pixel art, drawn from the same sprite data the terminal uses:
 *
 *   bun app/scripts/site-art.ts      writes site/mne.svg, site/wordmark.svg, site/favicon.svg
 *
 * Each pixel is a square; horizontal runs of one colour are merged into one
 * rectangle, so the files stay small and stay sharp at any size.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { mne, mneMini, pixelText, type Grid } from "../src/ui/pixel.ts";

export function toSvg(grid: Grid, title: string): string {
  const w = Math.max(...grid.map((r) => r.length));
  const rects: string[] = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < w) {
      const c = row[x] ?? null;
      let n = 1;
      while (x + n < w && (row[x + n] ?? null) === c) n++;
      if (c) rects.push(`<rect x="${x}" y="${y}" width="${n}" height="1" fill="${c}"/>`);
      x += n;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${grid.length}" shape-rendering="crispEdges" role="img" aria-label="${title}"><title>${title}</title>${rects.join("")}</svg>\n`;
}

if (import.meta.main) {
  const out = path.resolve(import.meta.dir, "..", "..", "site");
  fs.mkdirSync(out, { recursive: true });
  const files: [string, string][] = [
    ["mne.svg", toSvg(mne.idle, "Mne, Mnemo's elephant mascot")],
    ["wordmark.svg", toSvg(pixelText("MNEMO"), "MNEMO")],
    ["favicon.svg", toSvg(mneMini("#A99CC4"), "Mnemo")],
  ];
  for (const [name, svg] of files) {
    fs.writeFileSync(path.join(out, name), svg);
    console.log(`${name}  ${svg.length} bytes`);
  }
}
