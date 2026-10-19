/**
 * Installed skill bundles (`mnemo skills`) join the skills pi loads, but only the ones whose
 * files are exactly what was pinned. One that changed is left out, and the user is told.
 */
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { marketDir, verifyAll } from "../market/store.ts";
import type { Host } from "./host.ts";

export function marketExtension(host: Host) {
  return (pi: ExtensionAPI): void => {
    pi.on("resources_discover", () => {
      const { ok, bad } = verifyAll(host.home);
      if (host.depth === 0) for (const b of bad) host.ui?.note({ kind: "skill", text: `skill ${b.name} was not loaded: ${b.reason}. mnemo skills verify says more.` });
      return { skillPaths: ok.map((n) => path.join(marketDir(host.home), n)) };
    });
  };
}
