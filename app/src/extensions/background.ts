/**
 * What background memory work found (background/), told to the conversation with its next
 * prompt: only results that landed since its last turn and are about its project or none in
 * particular. A sub-agent is not told; its parent is.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { projectIdentity } from "@mnemo/memory";
import { backgroundMessage, eventsFor } from "../background/feed.ts";
import { readEvents } from "../background/store.ts";
import type { Host } from "./host.ts";

export function backgroundExtension(host: Host, now: () => number = Date.now) {
  return (pi: ExtensionAPI): void => {
    if (host.depth > 0) return;
    let since = now();
    const projects = new Map<string, string>();
    pi.on("before_agent_start", async (_event, ctx) => {
      const fresh = readEvents(host.home).filter((e) => e.at > since);
      if (!fresh.length) return undefined;
      since = Math.max(...fresh.map((e) => e.at));
      if (!projects.has(ctx.cwd)) projects.set(ctx.cwd, projectIdentity(ctx.cwd).id);
      const mine = eventsFor(fresh, 0, projects.get(ctx.cwd));
      if (!mine.length) return undefined;
      return { message: { customType: "mnemo-background", content: backgroundMessage(mine), display: false } };
    });
  };
}
