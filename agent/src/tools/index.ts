export { bashExecTool, runBash, type BashDetails } from "./bash_exec.ts";
export { readFileTool } from "./read_file.ts";
export { writeFileTool } from "./write_file.ts";
export { applyEditTool, applyEditToText } from "./apply_edit.ts";
export { globListTool } from "./glob_list.ts";
export { IPyKernel, sharedKernel, ipyRunTool, type IpyResult } from "./ipy_run.ts";
export { subagentSpawnTool, runSubagent, composeChildPrompt, extractAnswer } from "./subagent.ts";
export { getWorkspaceRoot, setWorkspaceRoot, resolveInWorkspace } from "./workspace.ts";
export {
  listSkillsTool,
  loadSkillTool,
  createSkillTool,
  patchSkillTool,
  retireSkillTool,
  sanitizeSkillName,
  setSkillsHome,
  setMnemoHome,
  globalSkillDir,
} from "./skills.ts";
export { webFetchTool, webSearchTool, htmlToText, fetchUrl, search, formatHits,
  pickSearchProvider, NO_SEARCH_KEY_MESSAGE, type SearchHit } from "./web.ts";
export { readImageTool, sniffMimeType, humanBytes, MAX_IMAGE_BYTES } from "./read_image.ts";
export { textResult, imageResult, textOf, type SeaTool, type ToolResult,
  type TextContent, type ImageContent } from "./types.ts";
export {
  TOOLS_FILE, toolsFile, projectToolsFile, readToolsFile, loadScopedToolPolicy,
  applyToolPolicy, type ToolPolicy, type PolicyFileRead, type PolicyOptions,
} from "./policy.ts";

import { bashExecTool } from "./bash_exec.ts";
import { readFileTool } from "./read_file.ts";
import { writeFileTool } from "./write_file.ts";
import { applyEditTool } from "./apply_edit.ts";
import { globListTool } from "./glob_list.ts";
import { ipyRunTool } from "./ipy_run.ts";
import { subagentSpawnTool } from "./subagent.ts";
import { createHarnessTool } from "./harness.ts";
import { listSkillsTool, loadSkillTool, createSkillTool, patchSkillTool, retireSkillTool } from "./skills.ts";
import { webFetchTool, webSearchTool } from "./web.ts";
import { readImageTool } from "./read_image.ts";
import type { SeaTool } from "./types.ts";
import { applyToolPolicy, loadScopedToolPolicy } from "./policy.ts";

/** Every tool this build ships, policy aside. */
export const toolInventory: SeaTool[] = [
  bashExecTool,
  readFileTool,
  writeFileTool,
  applyEditTool,
  globListTool,
  ipyRunTool,
  listSkillsTool,
  loadSkillTool,
  createSkillTool,
  patchSkillTool,
  retireSkillTool,
  subagentSpawnTool,
  createHarnessTool,
  webFetchTool,
  webSearchTool,
  readImageTool,
];

/**
 * The tools a session may actually use: the inventory, minus whatever
 * `~/.mnemo/tools.json` (or the project's copy) switches off.
 *
 * The filter is applied here, once, at the bottom of the inventory — not at
 * each registration site — because this list is what every consumer already
 * reads: the inline extension registers it, and the in-kernel `tools.<name>()`
 * dispatcher is built from the same array. A disabled tool is therefore absent
 * from the prompt *and* from generated Python, which is the whole point of a
 * policy: the model cannot ask for what it was never offered.
 *
 * The read happens at import (see `policy.ts` for why, what it costs, and the
 * next-run timing rule). With no policy file the array is the inventory
 * unchanged, so this is invisible until someone writes the file.
 *
 * The read is not free of a decision the caller could regret, and it is stated
 * rather than implied: a process whose cwd is the project it serves gets the
 * project's file, and `MNEMO_HOME` moves the user's. Both are what a policy
 * file is for; neither can turn a tool *on*.
 */
export const allTools: SeaTool[] = applyToolPolicy(toolInventory, loadScopedToolPolicy());

export const toolNames = allTools.map((t) => t.name);
