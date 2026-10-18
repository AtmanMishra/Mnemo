import { THEMES } from "./themes.js";

export const THEME_CHOICES: { value: string; label: string }[] = [{ value: "editor", label: "Match VS Code" }, ...Object.entries(THEMES).map(([value, t]) => ({ value, label: t.label }))];

/** WCAG relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const ch = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Whichever of the palette's ground and text reads better on `bg` (button labels). */
export function onColor(bg: string, ground: string, text: string): string {
  return contrast(bg, ground) >= contrast(bg, text) ? ground : text;
}

/**
 * The panel's CSS custom properties for a palette, or none for "editor" (the
 * stylesheet's defaults then take the editor's own colours). `scheme` is for the
 * browser's own controls (scrollbars, checkboxes).
 */
export function themeVars(name: string): { vars: Record<string, string>; scheme: "light" | "dark" } | undefined {
  const t = THEMES[name];
  if (!t) return undefined;
  const c = t.colors as Record<string, string>;
  return {
    scheme: luminance(c.ground!) > 0.4 ? "light" : "dark",
    vars: {
      "--bg": c.ground!,
      "--panel": c.panel!,
      "--rule": c.rule!,
      "--fg": c.text!,
      "--dim": c.dim!,
      "--accent": c.magenta!,
      "--accenth": c.blush!,
      "--onaccent": onColor(c.magenta!, c.ground!, c.text!),
      "--cyan": c.cyan!,
      "--amber": c.amber!,
      "--amberbg": `color-mix(in srgb, ${c.amber} 16%, transparent)`,
      "--green": c.green!,
      "--red": c.red!,
      "--violet": c.violet!,
      "--addbg": c.addBg!,
      "--delbg": c.removeBg!,
      "--selbg": c.selectBg!,
      "--codebg": c.panel!,
      "--inputbg": c.panel!,
      "--btn2": c.rule!,
      "--btn2h": c.selectBg!,
    },
  };
}
