import { describe, expect, test } from "bun:test";
import { contrast, themeVars, THEME_CHOICES } from "../src/webview/theme.ts";
import { THEMES } from "../src/webview/themes.ts";

describe("themeVars", () => {
  test("editor and unknown names set nothing, so the editor's colours stand", () => {
    expect(themeVars("editor")).toBeUndefined();
    expect(themeVars("nope")).toBeUndefined();
  });

  test("every palette is offered, and the light ones tell the browser", () => {
    expect(THEME_CHOICES.map((c) => c.value)).toEqual(["editor", ...Object.keys(THEMES)]);
    expect(themeVars("paper")!.scheme).toBe("light");
    expect(themeVars("solarized")!.scheme).toBe("light");
    expect(themeVars("night")!.scheme).toBe("dark");
  });

  test("text, secondary text and button labels stay readable in every palette", () => {
    for (const name of Object.keys(THEMES)) {
      const v = themeVars(name)!.vars;
      expect(contrast(v["--fg"]!, v["--bg"]!)).toBeGreaterThanOrEqual(7);
      expect(contrast(v["--dim"]!, v["--bg"]!)).toBeGreaterThanOrEqual(3);
      expect(contrast(v["--onaccent"]!, v["--accent"]!)).toBeGreaterThanOrEqual(3);
    }
  });
});
