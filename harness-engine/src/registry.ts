/**
 * Scoped tool registry (dsh pattern): three layers, global < project < session.
 * Same-named tools in a nearer scope shadow farther ones — that is the DESIGN,
 * but it is LOUD (b02291c2): registering a bundle whose tool names shadow
 * broader-scope tools records a ShadowEvent (registry.shadowEvents) and warns
 * via console.warn / the onShadowWarning constructor hook, so a project or
 * session bundle can never silently replace a global tool.
 * register() returns a Disposable; dispose() unregisters and deactivates the
 * bundle's tools.
 */
import { SCOPE_ORDER, type Disposable, type ScopeName, type ToolDefinition } from "./types.ts";
import type { LoadedBundle } from "./bundle.ts";

export interface RegisteredBundle extends LoadedBundle {
  scope: ScopeName;
}

export interface ToolInfo {
  name: string;
  description?: string;
  scope: ScopeName;
  bundleId: string;
  active: boolean;
}

/** A bundle was registered whose tools shadow same-named tools in broader scopes. */
export interface ShadowEvent {
  bundle: string;
  scope: ScopeName;
  /** Tool names that now hide a broader-scope tool. */
  tools: string[];
}

export interface ToolRegistryOptions {
  /** Called (in addition to console.warn) whenever a bundle shadows broader-scope tools. */
  onShadowWarning?: (event: ShadowEvent) => void;
}

export class ToolRegistry {
  #layers = new Map<ScopeName, Map<string, RegisteredBundle>>(
    SCOPE_ORDER.map((s) => [s, new Map()] as const),
  );
  /** Tool names activated via setActive()/the loader tool. */
  #active = new Set<string>();
  /** Recent shadowing events, most recent first (capped at 50). */
  shadowEvents: ShadowEvent[] = [];
  #onShadowWarning?: ToolRegistryOptions["onShadowWarning"];

  constructor(options: ToolRegistryOptions = {}) {
    this.#onShadowWarning = options.onShadowWarning;
  }

  /**
   * Register a loaded bundle at `scope` (default "session"). If the same layer
   * already holds a bundle with this manifest name, the old entry is replaced
   * (its tools deactivated) and its Disposable becomes inert.
   */
  register(bundle: LoadedBundle, scope: ScopeName = "session"): Disposable {
    const layer = this.#layers.get(scope)!;
    const entry: RegisteredBundle = { ...bundle, scope };
    const prev = layer.get(bundle.manifest.name);
    if (prev) {
      for (const name of prev.tools.keys()) this.#active.delete(name);
    }
    layer.set(bundle.manifest.name, entry);

    // b02291c2: nearest-shadows is the design — but never silent. If this
    // bundle hides tools that broader scopes already provide, say so.
    const shadowedTools = [...bundle.tools.keys()].filter((name) => {
      for (const broader of SCOPE_ORDER) {
        if (broader === scope) break; // only layers BELOW this scope are shadowed
        if ([...this.#layers.get(broader)!.values()].some((b) => b.tools.has(name))) {
          return true;
        }
      }
      return false;
    });
    if (shadowedTools.length > 0) {
      const event: ShadowEvent = { bundle: bundle.manifest.name, scope, tools: shadowedTools };
      this.shadowEvents.unshift(event);
      this.shadowEvents.length = Math.min(this.shadowEvents.length, 50);
      (this.#onShadowWarning ?? ((e: ShadowEvent) =>
        console.warn(
          `[harness-registry] warning: bundle "${e.bundle}" (${e.scope}) shadows ` +
            `broader-scope tools: ${e.tools.join(", ")}`,
        )))(event);
    }

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (layer.get(bundle.manifest.name) === entry) {
          layer.delete(bundle.manifest.name);
          for (const name of entry.tools.keys()) this.#active.delete(name);
        }
      },
    };
  }

  /** Nearest-scope lookup by tool name. Undefined if no scope provides it. */
  resolve(name: string): { tool: ToolDefinition; scope: ScopeName; bundle: RegisteredBundle } | undefined {
    for (const scope of [...SCOPE_ORDER].reverse()) {
      for (const bundle of this.#layers.get(scope)!.values()) {
        const tool = bundle.tools.get(name);
        if (tool) return { tool, scope, bundle };
      }
    }
    return undefined;
  }

  /** All visible tools (shadowed duplicates excluded). */
  list(): ToolInfo[] {
    const out: ToolInfo[] = [];
    for (const scope of [...SCOPE_ORDER].reverse()) {
      for (const bundle of this.#layers.get(scope)!.values()) {
        for (const [name, tool] of bundle.tools) {
          if (!out.some((t) => t.name === name)) {
            out.push({
              name,
              description: tool.description,
              scope,
              bundleId: bundle.id,
              active: this.#active.has(name),
            });
          }
        }
      }
    }
    return out;
  }

  /** Drop any registered bundle that was loaded from `dir` (watcher invalidation). */
  unregisterByDir(dir: string): string | undefined {
    const abs = dir;
    for (const [scope, layer] of this.#layers) {
      for (const [name, bundle] of layer) {
        if (bundle.dir === abs) {
          layer.delete(name);
          for (const t of bundle.tools.keys()) this.#active.delete(t);
          return `${scope}:${name}`;
        }
      }
    }
    return undefined;
  }

  setActive(names: string[]): void {
    for (const n of names) if (this.resolve(n)) this.#active.add(n);
  }

  deactivate(names: string[]): void {
    for (const n of names) this.#active.delete(n);
  }

  activateTool(name: string): boolean {
    if (!this.resolve(name)) return false;
    this.#active.add(name);
    return true;
  }

  getActive(): string[] {
    return [...this.#active];
  }

  isActive(name: string): boolean {
    return this.#active.has(name);
  }
}


