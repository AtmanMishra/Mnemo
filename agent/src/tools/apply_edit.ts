import * as fs from "node:fs/promises";
import { Type } from "typebox";
import { resolveInWorkspace } from "./workspace.ts";
import { textResult, type SeaTool } from "./types.ts";

const parameters = Type.Object({
  path: Type.String({ description: "File to edit (absolute or relative to workspace root)." }),
  old_str: Type.String({ description: "Exact text to replace. Must appear exactly once unless replace_all is true." }),
  new_str: Type.String({ description: "Replacement text." }),
  replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence of old_str. Default false." })),
});

export function applyEditToText(text: string, oldStr: string, newStr: string, replaceAll: boolean): string {
  if (oldStr.length === 0) throw new Error("apply_edit: old_str must be a non-empty string");
  const occurrences = text.split(oldStr).length - 1;
  if (occurrences === 0) {
    throw new Error(`apply_edit: old_str not found in file. No changes made.`);
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `apply_edit: old_str appears ${occurrences} times; refusing ambiguous edit. ` +
        `Provide more surrounding context or set replace_all=true.`,
    );
  }
  return replaceAll ? text.replaceAll(oldStr, newStr) : text.replace(oldStr, newStr);
}

export const applyEditTool: SeaTool = {
  name: "apply_edit",
  label: "Apply edit",
  description:
    "Exact string replacement in a file: replaces old_str with new_str. Fails if old_str is not found or appears more than once without replace_all.",
  parameters,
  async execute(_id, params) {
    const abs = resolveInWorkspace(params.path);
    let text: string;
    try {
      text = await fs.readFile(abs, "utf8");
    } catch (err: any) {
      throw new Error(`apply_edit: cannot read ${abs}: ${err?.message ?? err}`);
    }
    const updated = applyEditToText(text, params.old_str, params.new_str, params.replace_all ?? false);
    await fs.writeFile(abs, updated, "utf8");
    const replacements = params.replace_all ? text.split(params.old_str).length - 1 : 1;
    return textResult(`Applied edit to ${abs}`, { path: abs, replacements });
  },
};
