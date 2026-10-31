/**
 * Notes for one model: `agent/models/<model id>.md`, added to the system prompt
 * whenever that model runs, the main session and sub-agents alike. What one
 * model needs telling ("edit with the edit tool, not here-documents") is noise
 * for another, so it does not belong in memory or a profile. The files are on
 * the evolve surface (evolve/surface.ts): every change is kept and revertible.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../runtime/paths.ts";
import type { Host } from "./host.ts";

const MAX_NOTES = 16 * 1024;

/** The notes file for a model id; characters a file name cannot hold become `_`. */
export function modelNotesFile(home: string, modelId: string): string {
  return path.join(agentDir(home), "models", `${modelId.replace(/[/\\:*?"<>|]/g, "_")}.md`);
}

export function readModelNotes(home: string, modelId: string): string | undefined {
  try {
    const text = fs.readFileSync(modelNotesFile(home, modelId), "utf8").trim();
    return text ? text.slice(0, MAX_NOTES) : undefined;
  } catch {
    return undefined;
  }
}

export function modelNotesExtension(host: Host) {
  return (pi: ExtensionAPI): void => {
    pi.on("before_agent_start", (event, ctx) => {
      const notes = ctx.model && readModelNotes(host.home, ctx.model.id);
      if (notes) event.systemPromptOptions.sections.model_notes = `Notes for working as ${ctx.model!.id}, kept by the user:\n\n${notes}`;
    });
  };
}
