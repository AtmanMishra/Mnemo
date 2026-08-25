import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
import { getWorkspaceRoot } from "./workspace.ts";
import { textResult, type SeaTool } from "./types.ts";

const MAX_RESULTS = 1000;

const parameters = Type.Object({
  pattern: Type.String({ description: "Glob pattern, e.g. 'src/**/*.ts'. Matched against paths relative to root." }),
  root: Type.Optional(Type.String({ description: "Directory to search under. Default: workspace root." })),
});

export const globListTool: SeaTool = {
  name: "glob_list",
  label: "Glob list",
  description: "List files under the workspace root matching a glob pattern.",
  parameters,
  async execute(_id, params) {
    const root = params.root ? path.resolve(params.root) : getWorkspaceRoot();
    const matches: string[] = [];
    try {
      for await (const entry of fs.glob(params.pattern, { cwd: root })) {
        matches.push(entry.split(path.sep).join("/"));
        if (matches.length >= MAX_RESULTS) break;
      }
    } catch (err: any) {
      throw new Error(`glob_list: ${err?.message ?? err}`);
    }
    matches.sort();
    const note = matches.length >= MAX_RESULTS ? `\n(truncated at ${MAX_RESULTS} entries)` : "";
    const body = matches.length > 0 ? matches.join("\n") : "(no matches)";
    return textResult(body + note, { pattern: params.pattern, root, count: matches.length });
  },
};
