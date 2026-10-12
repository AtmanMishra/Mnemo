/**
 * Clickable links (OSC 8): file paths in tool titles open the file, links in
 * answers open the page. Terminals that do not know OSC 8 drop it and show the
 * text. On only for a real terminal; MNEMO_LINKS=0 turns it off.
 */
import * as path from "node:path";
import { pathToFileURL } from "node:url";

let enabled = false;

export function setLinks(on: boolean): void {
  enabled = on;
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
