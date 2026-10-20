/**
 * Skills installed from marketplaces (`mnemo skills`) join the skills pi loads, but only the ones
 * whose files are exactly what was installed. One that changed is left out, and the user is told.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { verifyAll } from "../market/store.ts";
import type { Host } from "./host.ts";

export function marketExtension(host: Host) {
  return (pi: ExtensionAPI): void => {
    pi.on("resources_discover", () => {
      const { ok, bad } = verifyAll(host.home);
      if (host.depth === 0) for (const b of bad) host.ui?.note({ kind: "skill", text: `skill ${b.skill} was not loaded: ${b.reason}. mnemo skills verify says more.` });
      return { skillPaths: ok };
    });
  };
}
