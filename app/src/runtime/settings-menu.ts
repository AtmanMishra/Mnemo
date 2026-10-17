/**
 * The ways to change a setting: the `/settings` menu (a loop of the dialogs every
 * other question uses), and the same changes as words (`/settings wakeSpend 1`,
 * `mnemo settings set theme nord`). Both go through `SettingsStore.set`, so a value
 * is checked once, in one place, whichever way it arrives.
 */
import type { Choice, Dialogs } from "./dialogs.ts";
import { DEFS, GROUPS, isKey, SETTING_KEYS, showValue, type SettingKey, type SettingsStore } from "./settings.ts";

export interface MenuDeps {
  settings: SettingsStore;
  dialogs: Dialogs;
  notice(text: string, tone?: "info" | "warn" | "error"): void;
  /** A setting changed: do whatever it needs beyond saving (repaint the theme, move the mouse). */
  applied(key: SettingKey | undefined): void;
}

const RESET_ALL = "@reset-all";

function describe(settings: SettingsStore, k: SettingKey): string {
  const def = DEFS[k];
  const value = settings.get()[k];
  const changed = value !== def.default;
  return `${showValue(k, value)}${changed ? `  (default ${showValue(k, def.default)})` : ""}${def.restart ? "  · next launch" : ""}`;
}

/** One line per setting, grouped, for `/settings list` and `mnemo settings`. */
export function settingsText(settings: SettingsStore): string {
  const out: string[] = [];
  for (const g of GROUPS) {
    out.push(g);
    for (const k of SETTING_KEYS.filter((x) => DEFS[x].group === g)) out.push(`  ${k.padEnd(18)} ${describe(settings, k)}`);
  }
  return out.join("\n");
}

/** The explanation for one setting: what it is, its range, its default. */
export function settingHelp(k: SettingKey): string {
  const def = DEFS[k];
  const range = def.options ? `one of ${def.options.join(", ")}` : def.min !== undefined ? `${def.min} to ${def.max}${def.unit && def.unit !== "$" ? ` ${def.unit}` : ""}` : def.kind === "bool" ? "on or off" : def.kind === "chord" ? "a chord such as ctrl+o or alt+j" : "text";
  return `${def.label}: ${def.help} (${range}; default ${showValue(k, def.default)})`;
}

/**
 * Settings as words: nothing → the list; `key` → its value; `key value` or `set key value`;
 * `reset [key]`. Returns what to say and whether it worked.
 */
export function settingsCommand(settings: SettingsStore, argv: string[], applied?: (key: SettingKey | undefined) => void): { ok: boolean; text: string } {
  const [first, ...rest] = argv;
  if (!first || first === "list") return { ok: true, text: settingsText(settings) };
  const key = (name: string | undefined): SettingKey | undefined => SETTING_KEYS.find((k) => k.toLowerCase() === name?.toLowerCase());
  if (first === "reset") {
    const k = rest[0] ? key(rest[0]) : undefined;
    if (rest[0] && !k) return { ok: false, text: `No setting called ${rest[0]}. /settings lists them.` };
    settings.reset(k);
    applied?.(k);
    return { ok: true, text: k ? `${DEFS[k].label}: ${describe(settings, k)}` : "Every setting is back to its default." };
  }
  const [name, ...value] = first === "set" || first === "get" ? rest : argv;
  const k = key(name);
  if (!k) return { ok: false, text: `No setting called ${name ?? ""}. /settings lists them.` };
  if (first === "get" || value.length === 0) return { ok: true, text: `${settingHelp(k)}\nNow: ${describe(settings, k)}` };
  const done = settings.set(k, value.join(" "));
  if (!done.ok) return { ok: false, text: done.error };
  applied?.(k);
  return { ok: true, text: `${DEFS[k].label}: ${describe(settings, k)}` };
}

/** The menu: pick a setting, change it, come back to the list, until esc. */
export async function settingsMenu(d: MenuDeps): Promise<void> {
  const next = new Set<string>();
  let at: string | undefined;
  for (;;) {
    const choices: Choice[] = [
      ...SETTING_KEYS.map((k) => ({ value: k, label: `${DEFS[k].group} · ${DEFS[k].label}`, description: describe(d.settings, k), keywords: `${k} ${DEFS[k].help}` })),
      { value: RESET_ALL, label: "Reset everything", description: "back to the defaults" },
    ];
    const pick = await d.dialogs.select("Settings", choices, undefined, at);
    if (!pick) break;
    at = pick;
    if (pick === RESET_ALL) {
      if (await d.dialogs.confirm("Reset every setting?", "Theme, limits, keys and the rest go back to what Mnemo ships with.")) {
        d.settings.reset();
        d.applied(undefined);
      }
      continue;
    }
    if (!isKey(pick)) continue;
    const def = DEFS[pick];
    const now = d.settings.get()[pick];
    let raw: string | boolean | undefined;
    if (def.kind === "bool") raw = !now;
    else if (def.kind === "enum")
      raw = await d.dialogs.select(
        def.label,
        def.options!.map((o) => ({ value: o, label: o, description: o === now ? "current" : o === def.default ? "default" : undefined })),
        undefined,
        String(now),
      );
    else raw = await d.dialogs.text(`${def.label}: ${def.help}`, { initial: String(now), placeholder: String(def.default) });
    if (raw === undefined || (raw === "" && def.kind !== "text")) continue;
    const done = d.settings.set(pick, raw);
    if (!done.ok) {
      d.notice(done.error, "warn");
      continue;
    }
    d.applied(pick);
    if (def.restart) next.add(def.label);
  }
  if (next.size) d.notice(`Saved. ${[...next].join(", ")} take${next.size === 1 ? "s" : ""} effect the next time Mnemo starts.`);
}
