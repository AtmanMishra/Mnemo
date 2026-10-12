/** Every theme: every colour set, and text, dim text and accents readable on its ground. */
import { test, expect } from "bun:test";
import { THEMES, type PaletteKey } from "../src/ui/theme.ts";

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

const KEYS = Object.keys(THEMES.night.colors) as PaletteKey[];

for (const [name, t] of Object.entries(THEMES))
  test(`${name}: complete and readable`, () => {
    expect(Object.keys(t.colors).sort()).toEqual([...KEYS].sort());
    for (const k of KEYS) expect(t.colors[k]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(contrast(t.colors.text, t.colors.ground)).toBeGreaterThanOrEqual(7);
    expect(contrast(t.colors.dim, t.colors.ground)).toBeGreaterThanOrEqual(3);
    for (const k of ["magenta", "cyan", "amber", "green", "red"] as const) expect(contrast(t.colors[k], t.colors.ground)).toBeGreaterThanOrEqual(3);
  });
