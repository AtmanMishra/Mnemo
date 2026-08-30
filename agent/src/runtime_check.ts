/**
 * 6.2 Node version guard.
 *
 * Mnemo runs .ts files directly on Node's native type stripping, which lands
 * in 22.6. On an older Node the failure is a raw SyntaxError pointing at a type
 * annotation, which tells the user nothing about what to do. This turns that
 * into one sentence.
 */
export const MIN_NODE = { major: 22, minor: 6 };

export function parseNodeVersion(version: string): { major: number; minor: number } | null {
  const m = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

export function isSupportedNode(version: string): boolean {
  const v = parseNodeVersion(version);
  if (!v) return true; // an unrecognisable version is not proof of an old one
  if (v.major !== MIN_NODE.major) return v.major > MIN_NODE.major;
  return v.minor >= MIN_NODE.minor;
}

export function unsupportedNodeMessage(version: string): string {
  return [
    `mnemo needs Node >= ${MIN_NODE.major}.${MIN_NODE.minor}, but this is ${version}.`,
    "",
    "Mnemo runs TypeScript directly on Node's native type stripping, which",
    `arrived in ${MIN_NODE.major}.${MIN_NODE.minor}. On an older Node you get a`,
    "SyntaxError on a type annotation instead of this message.",
    "",
    "  nvm install 22.6   (or newer)",
    "  nvm use 22.6",
  ].join("\n");
}

/** Returns the message to print, or null when the runtime is fine. */
export function checkNodeVersion(version = process.version): string | null {
  return isSupportedNode(version) ? null : unsupportedNodeMessage(version);
}
