import * as fs from "node:fs/promises";
import { Type } from "typebox";
import { resolveInWorkspace } from "./workspace.ts";
import { textResult, type SeaTool } from "./types.ts";

const parameters = Type.Object({
  path: Type.String({ description: "File path (absolute or relative to workspace root)." }),
  offset: Type.Optional(Type.Number({ description: "1-based first line to read." , minimum: 1})),
  limit: Type.Optional(Type.Number({ description: "Max number of lines to read." , minimum: 1})),
});

export const readFileTool: SeaTool = {
  name: "read_file",
  label: "Read file",
  description: "Read a UTF-8 text file, optionally a slice of lines.",
  parameters,
  async execute(_id, params) {
    const abs = resolveInWorkspace(params.path);
    let raw: string;
    try {
      raw = await fs.readFile(abs, "utf8");
    } catch (err: any) {
      throw new Error(`read_file: cannot read ${abs}: ${err?.message ?? err}`);
    }
    const lines = raw.split("\n");
    // Trailing newline yields an empty final element; drop it for line math.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const total = lines.length;
    const start = Math.max(0, (params.offset ?? 1) - 1);
    const end = Math.min(total, start + (params.limit ?? total));
    const selected = lines.slice(start, end).join("\n");
    return textResult(selected || "(empty file)", {
      path: abs,
      totalLines: total,
      returnedLines: [start + 1, end],
      truncated: end < total,
    });
  },
};
