/**
 * 6.2 Node version guard.
 *
 * Mnemo runs .ts files directly on Node's native type stripping. 22.6 shipped
 * that feature behind `--experimental-strip-types`; 22.18 turned it on by
 * default, and that is the version that actually runs our files with no flags
 * — which is what this project means by "no build step", and what CI pins.
 *
 * On an older Node the failure is a raw SyntaxError pointing at a type
 * annotation, which tells the user nothing about what to do. This turns that
 * into one sentence.
 */
export const MIN_NODE = { major: 22, minor: 18 };

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
    "Mnemo runs TypeScript directly on Node's native type stripping. It arrived",
    `in 22.6 behind a flag and became the default in ${MIN_NODE.major}.${MIN_NODE.minor};`,
    "before that you get a SyntaxError on a type annotation instead of this message.",
    "",
    "  nvm install 22.18   (or newer)",
    "  nvm use 22.18",
  ].join("\n");
}

/** Returns the message to print, or null when the runtime is fine. */
export function checkNodeVersion(version = process.version): string | null {
  return isSupportedNode(version) ? null : unsupportedNodeMessage(version);
}

// ---------------------------------------------------------------------------
// Bun — the runtime the application itself is moving to.
//
// The Node floor above is about TYPE STRIPPING on a runtime the app borrowed.
// This one is about the application's own runtime: the entry point is a Bun
// program, and everything it does (importing .ts directly, spawning the Python
// kernel, reading the sidecar's journal) assumes Bun's semantics rather than
// Node's. Running it on Node is not a degraded mode, it is the wrong program,
// so the message says so in one sentence and names the command that fixes it.
//
// The floor is a version this repository already proved: 1.3.14, the Bun the
// agent's own dependency metadata requires (`engines.bun` in the oh-my-pi
// reference and `packageManager: bun@>=1.4` upstream). Pinned rather than
// floated, because a floor that moves is a floor nobody can reproduce.
export const MIN_BUN = { major: 1, minor: 3 };

export function parseBunVersion(version: string): { major: number; minor: number } | null {
  const m = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

export function isSupportedBun(version: string): boolean {
  const v = parseBunVersion(version);
  if (!v) return true; // unreadable is not proof of old, same rule as Node
  if (v.major !== MIN_BUN.major) return v.major > MIN_BUN.major;
  return v.minor >= MIN_BUN.minor;
}

export function unsupportedBunMessage(version: string): string {
  return [
    `mnemo runs on Bun >= ${MIN_BUN.major}.${MIN_BUN.minor}, but this is ${version}.`,
    "",
    "The application, its TypeScript, and the child processes it starts all assume",
    "Bun; on any other runtime this is the wrong program rather than a slower one.",
    "",
    "  bun upgrade            # or: curl -fsSL https://bun.sh/install | bash",
    "",
    `Then run the app again:  bun ${"bin/mnemo-bun.ts"}`,
  ].join("\n");
}

/** Returns the message to print, or null when the runtime is fine. */
export function checkBunVersion(version: string | undefined = (globalThis as { Bun?: { version: string } }).Bun?.version): string | null {
  if (!version) return unsupportedBunMessage("(not Bun)");
  return isSupportedBun(version) ? null : unsupportedBunMessage(version);
}
