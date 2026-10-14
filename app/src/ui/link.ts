/**
 * Clickable links (OSC 8): file paths in tool titles open the file, links in
 * answers open the page. Terminals that do not know OSC 8 drop it and show the
 * text. On only for a real terminal; MNEMO_LINKS=0 turns it off.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

let enabled = false;

export function setLinks(on: boolean): void {
  enabled = on;
}

export function linksOn(): boolean {
  return enabled;
}

/** Only schemes a terminal can hand to the system safely. */
const SAFE = /^(https?:|file:|mailto:)/i;

export function hyperlink(url: string, text: string): string {
  if (!enabled || !SAFE.test(url) || /[\x00-\x1f\x7f]/.test(url)) return text;
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

export function fileLink(file: string, cwd: string, text = file): string {
  return hyperlink(pathToFileURL(path.resolve(cwd, file)).href, text);
}

/** A long URL's visible text: the whole of it when it fits, else its start and an ellipsis (the link itself stays whole). */
export function linkLabel(url: string, room: number): string {
  return url.length <= room ? url : `${url.slice(0, Math.max(12, room - 1))}…`;
}

/**
 * Hand a URL to the system's browser without waiting on it. Skipped when
 * BROWSER says not to ("true", "none"), or on a Linux with no display (an SSH
 * session); returns whether it tried.
 */
export function openBrowser(url: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (!SAFE.test(url) || /[\x00-\x20"\x7f]/.test(url)) return false;
  const browser = env.BROWSER?.trim();
  if (browser === "true" || browser === "none") return false;
  if (platform !== "darwin" && platform !== "win32" && !browser && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  const [cmd, args, verbatim] =
    platform === "darwin"
      ? ["open", [url], false]
      : platform === "win32"
        ? // Quoted, `&` in the query reaches start whole; the empty title keeps start from reading the URL as one.
          ["cmd", ["/c", "start", '""', `"${url}"`], true]
        : [browser || "xdg-open", [url], false];
  try {
    const child = spawn(cmd as string, args as string[], { detached: true, stdio: "ignore", windowsVerbatimArguments: verbatim as boolean });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** OSC 52: put text on the clipboard of the terminal (local even over SSH), where the terminal allows it. */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}
