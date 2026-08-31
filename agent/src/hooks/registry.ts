/**
 * AREA 9.5 support — hook registry: effective list, lookup, and a persistent
 * per-user disabled set (bare id or scope:id keys) stored at
 * <home>/.mnemo/hook-state.json. `/hook disable` writes here; the scanner
 * consults it on every load, so a disable survives restarts and applies across
 * scopes deterministically.
 *
 * Everything takes injected paths — no real machine state in tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadHooks, listPerScope, type ScanOptions } from "./scanner.ts";
import type { Hook, HookManifest, Scope } from "./types.ts";

export const STATE_FILE = "hook-state.json";

export interface DisabledState {
  /** Keys: bare id or `${scope}:${id}`. */
  disabled: string[];
}

export function statePath(home: string): string {
  return path.join(home, ".mnemo", STATE_FILE);
}

export function loadDisabled(home: string): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(home), "utf8")) as Partial<DisabledState>;
    if (!Array.isArray(raw.disabled)) return new Set();
    return new Set(raw.disabled.filter((d): d is string => typeof d === "string"));
  } catch {
    return new Set();
  }
}

export function saveDisabled(home: string, disabled: ReadonlySet<string>): void {
  const dir = path.dirname(statePath(home));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body: DisabledState = { disabled: [...disabled].sort() };
  fs.writeFileSync(statePath(home), JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
}

export interface HookRegistryOptions {
  scan: ScanOptions;
  /** Optional: base state; otherwise read from the scan home. */
  disabled?: ReadonlySet<string>;
  /** When given, writes persist here instead of the scan home. */
  stateOwner?: string;
}

/** Effective-scope lookup result for a plain id. */
export interface EffectiveRef {
  hook: Hook;
  scope: Scope;
  /** The scope key used for the disabled set. */
  key: string;
}

export class HookRegistry {
  readonly scan: ScanOptions;
  private readonly disabledSet: Set<string>;
  private readonly stateHome: string;

  constructor(opts: HookRegistryOptions) {
    this.scan = opts.scan;
    this.stateHome = opts.stateOwner ?? opts.scan.home;
    this.disabledSet = new Set(opts.disabled ?? loadDisabled(this.stateHome));
  }

  /** The effective, execution-ordered list (project,user,global; id-sorted). */
  hooks(): Hook[] {
    return loadHooks(this.scan, this.disabledSet);
  }

  /** Raw manifests per scope, for `/hook list`. */
  perScope(): Array<{ scope: Scope; root: string; hooks: HookManifest[] }> {
    const merged = this.hooks();
    return listPerScope(this.scan).map((row) => ({
      ...row,
      hooks: row.hooks.map((h) => merged.find((m) => m.id === h.id && m.scope === row.scope) ?? h),
    }));
  }

  /** The effective hook with this id, or null. */
  byId(id: string): Hook | null {
    return this.hooks().find((h) => h.id === id) ?? null;
  }

  /** The effective hook the raw id resolves to from any scope. */
  effective(id: string): EffectiveRef | null {
    const live = loadHooks(this.scan, this.disabledSet);
    for (const scope of ["project", "user", "global"] as Scope[]) {
      const hook = live.find((h) => h.id === id && h.scope === scope);
      if (hook) return { hook, scope, key: `${scope}:${id}` };
    }
    return null;
  }

  get disabled(): ReadonlySet<string> {
    return this.disabledSet;
  }

  isDisabled(id: string, scope?: Scope): boolean {
    return this.disabledSet.has(id) || (scope !== undefined && this.disabledSet.has(`${scope}:${id}`));
  }

  /** Disable the effective hook for a plain id; false when nothing matched. */
  disable(id: string): false | EffectiveRef {
    const ref = this.effective(id);
    if (!ref) return false;
    this.disabledSet.add(ref.key);
    saveDisabled(this.stateHome, this.disabledSet);
    return ref;
  }

  /** Re-enable by raw id or scope:id key. */
  enable(key: string): boolean {
    if (this.disabledSet.delete(key)) {
      saveDisabled(this.stateHome, this.disabledSet);
      return true;
    }
    return false;
  }
}