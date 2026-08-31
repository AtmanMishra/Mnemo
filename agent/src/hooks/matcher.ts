/**
 * AREA 9.1 — matcher engine.
 *
 * A hook matches a tool event when BOTH optional matcher fields pass:
 *   tool — regex against the tool name
 *   path — glob against the tool call's path-ish argument
 * An empty matcher matches everything; a path matcher does not match when the
 * tool call carries no path-ish argument at all.
 *
 * The glob engine is deliberately tiny (deps are pinned in go.mod-style, and
 * a glob engine does not deserve a dependency): * and ? never cross a path
 * separator, ** matches across separators, everything else is literal.
 */

/** Input keys that carry a path worth matching a path-glob against. */
export const PATH_KEYS = ["path", "file", "glob", "dst", "dir"] as const;

/** First path-ish string argument of a tool call, if any. */
export function toolPathArg(input: Record<string, unknown>): string | undefined {
  for (const k of PATH_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

/** Tool matcher: a regex. A broken pattern matches nothing (fail closed). */
export function matchTool(name: string, pattern?: string): boolean {
  if (!pattern) return true;
  try {
    return new RegExp(pattern).test(name);
  } catch {
    return false;
  }
}

/**
 * Minimal glob -> RegExp. `*`/`?` never match "/", `**` matches anything
 * including "/". A leading star-star-slash is collapsed, so `**.ts` still
 * anchors the whole match.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        let j = i + 2;
        if (glob[j] === "/") j++; // star-star-slash just consumes the slash
        // `**` at the end already absorbs a trailing slash via `.*`
        out += "(?:.*)";
        i = j;
        continue;
      }
      out += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    out += /[\\^$.[\]{}()|+?*]/.test(c) ? "\\" + c : c;
    i++;
  }
  return new RegExp(out + "$");
}

/** Path matcher: glob against a concrete path. Broken globs match nothing. */
export function matchPath(p: string, glob?: string): boolean {
  if (!glob) return true;
  try {
    return globToRegExp(glob).test(p);
  } catch {
    return false;
  }
}

/** The one matching entry point the executor uses. */
export interface ToolEventLike {
  toolName: string;
  input: Record<string, unknown>;
}

export function matchesHook(ev: ToolEventLike, matcher?: { tool?: string; path?: string }): boolean {
  if (!matcher) return true;
  if (matcher.tool && !matchTool(ev.toolName, matcher.tool)) return false;
  if (matcher.path) {
    const p = toolPathArg(ev.input);
    if (p === undefined) return false;
    if (!matchPath(p, matcher.path)) return false;
  }
  return true;
}