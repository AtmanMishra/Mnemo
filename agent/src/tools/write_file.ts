import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
import { resolveInWorkspace } from "./workspace.ts";
import { textResult, type SeaTool } from "./types.ts";

const parameters = Type.Object({
  path: Type.String({ description: "File path (absolute or relative to workspace root)." }),
  content: Type.String({ description: "Full file content to write." }),
});

export const writeFileTool: SeaTool = {
  name: "write_file",
  label: "Write file",
  description: "Create or overwrite a file with the given content. Parent directories are created automatically.",
  parameters,
  async execute(_id, params) {
    const abs = resolveInWorkspace(params.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, params.content, "utf8");
    return textResult(`Wrote ${params.content.length} bytes to ${abs}`, {
      path: abs,
      bytes: params.content.length,
    });
  },
};
