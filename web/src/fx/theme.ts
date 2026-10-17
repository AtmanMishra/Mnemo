// The page's colour tokens, read for the canvases and shaders that cannot use CSS.
// The CSS (styles.css) is the one source of the palette; these read it back.

export type RGB = [number, number, number];

export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** A token as 0..1 floats; a token that is not a #rrggbb colour reads as mid grey. */
export function rgb(name: string): RGB {
  const m = /^#([0-9a-f]{6})$/i.exec(token(name));
  if (!m) return [0.5, 0.5, 0.5];
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export const isDark = () => document.documentElement.getAttribute("data-theme") === "dark";

/** Calls `fn` whenever the theme changes (the toggle, or the system while on "system"). */
export function onTheme(fn: () => void): () => void {
  const mo = new MutationObserver(fn);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
}

/** Mne's six pixel colours, by sprite letter a..f (eye, outline, ear, hide, blush, tusk). */
export const ELEPHANT_TOKENS = ["--el-eye", "--el-line", "--el-ear", "--el-hide", "--el-blush", "--el-tusk"];
/** The memory's six areas, in the order docs/MNEMO-INTERNALS.md lists them. */
export const AREA_TOKENS = ["--magenta", "--cyan", "--mustard", "--salmon", "--violet", "--green"];
export const AREAS = ["Episodic", "Semantic", "Procedural", "Spatial", "Salience", "Executive"];
