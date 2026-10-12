import { useEffect, useState } from "react";

type Pick = "system" | "light" | "dark";
const ORDER: Pick[] = ["system", "light", "dark"];
const GLYPH: Record<Pick, string> = { system: "◐", light: "☀", dark: "☾" };

const read = (): Pick => {
  try {
    const v = localStorage.getItem("mnemo-theme");
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
};

/** System → light → dark. public/boot.js applies the same pick before first paint. */
export function ThemeToggle() {
  const [pick, setPick] = useState<Pick>("system");
  useEffect(() => setPick(read()), []);

  const next = () => {
    const p = ORDER[(ORDER.indexOf(pick) + 1) % ORDER.length]!;
    setPick(p);
    try {
      if (p === "system") localStorage.removeItem("mnemo-theme");
      else localStorage.setItem("mnemo-theme", p);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
    const dark = p === "dark" || (p === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  };

  return (
    <button type="button" className="theme-toggle" onClick={next} aria-label={`Theme: ${pick}. Change theme`} title={`Theme: ${pick}`}>
      <span aria-hidden="true">{GLYPH[pick]}</span>
      <span className="theme-label">{pick}</span>
    </button>
  );
}
