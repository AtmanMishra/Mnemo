/**
 * Watched skills directories. fs.watch + per-bundle-dir debounce (~500ms).
 * New/changed bundles are reloaded into the registry at the watched dir's
 * scope. Write-triggered invalidation: if a rewritten bundle no longer loads
 * (broken source, deleted files), the previously registered version is dropped.
 */
import { promises as fs } from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import * as path from "node:path";
import type { Disposable, ScopeName } from "./types.ts";
import type { ToolRegistry } from "./registry.ts";
import { loadBundle } from "./bundle.ts";

export interface WatchedDir {
  path: string;
  scope: ScopeName;
}

export interface WatcherOptions {
  debounceMs?: number; // default 500
  onError?(err: Error, bundleDir: string): void;
}

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

export class SkillsWatcher implements Disposable {
  #registry: ToolRegistry;
  #dirs: WatchedDir[];
  #debounceMs: number;
  #onError?: NonNullable<WatcherOptions["onError"]>;
  #watchers: FSWatcher[] = [];
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #pending = new Map<string, { root: string; scope: ScopeName; child: string | null }>();
  #started = false;
  /** Last invalidation/reload errors, most recent first. */
  errors: Array<{ bundleDir: string; message: string }> = [];

  constructor(registry: ToolRegistry, dirs: WatchedDir[], options: WatcherOptions = {}) {
    this.#registry = registry;
    this.#dirs = dirs.map((d) => ({ ...d, path: path.resolve(d.path) }));
    this.#debounceMs = options.debounceMs ?? 500;
    this.#onError = options.onError;
  }

  /**
   * Attach fs.watch to every watched dir. Resolves only after all watchers are
   * attached, so writes issued after `await start()` cannot be missed.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    for (const dir of this.#dirs) {
      await fs.mkdir(dir.path, { recursive: true });
      if (!this.#started) return;
      const w = watch(dir.path, { recursive: true }, (_event, filename) => {
        this.#schedule(dir, filename ? String(filename) : null);
      });
      w.on("error", (err) => this.#recordError(dir.path, err as Error));
      this.#watchers.push(w);
    }
  }

  #schedule(dir: WatchedDir, filename: string | null): void {
    // Map the event to the top-level child dir (= one skill bundle). Events on
    // the watched root itself rescan every child.
    let child: string | null = null;
    if (filename) {
      const parts = filename.split(path.sep).filter((p) => p !== "");
      // Top-level segment of the changed path == one bundle directory.
      // Events directly on the watched root (null filename) rescan everything.
      child = parts.length > 0 ? parts[0]! : null;
    }
    const key = child ? path.join(dir.path, child) : dir.path + "::all";
    clearTimeout(this.#timers.get(key));
    this.#timers.set(
      key,
      setTimeout(() => {
        this.#timers.delete(key);
        this.#refresh(dir, child).catch((err) => this.#recordError(key, err as Error));
      }, this.#debounceMs),
    );
  }

  async #refresh(dir: WatchedDir, child: string | null): Promise<void> {
    if (child !== null && !NAME_RE.test(child)) return; // ignore stray temp files
    const children =
      child !== null
        ? [child]
        : (await fs.readdir(dir.path, { withFileTypes: true }))
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
    for (const name of children) {
      if (!NAME_RE.test(name)) continue;
      const bundleDir = path.join(dir.path, name);
      try {
        const bundle = await loadBundle(bundleDir, dir.scope);
        this.#registry.register(bundle, dir.scope); // replaces same-name entry in this scope
      } catch (err) {
        // Invalidated: broken rewrite or deleted bundle -> drop previous version.
        this.#registry.unregisterByDir(bundleDir);
        this.#recordError(bundleDir, err as Error);
      }
    }
  }

  #recordError(where: string, err: Error): void {
    this.errors.unshift({ bundleDir: where, message: err.message });
    this.errors.length = Math.min(this.errors.length, 50);
    this.#onError?.(err, where);
  }

  stop(): void {
    this.#started = false;
    for (const w of this.#watchers.splice(0)) w.close();
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
  }

  dispose(): void {
    this.stop();
  }
}
