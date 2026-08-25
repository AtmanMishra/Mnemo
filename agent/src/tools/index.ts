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
  sanitizeSkillName,
  setSkillsHome,
  globalSkillDir,
} from "./skills.ts";
export { textResult, type SeaTool, type ToolResult, type TextContent } from "./types.ts";

import { bashExecTool } from "./bash_exec.ts";
import { readFileTool } from "./read_file.ts";
import { writeFileTool } from "./write_file.ts";
import { applyEditTool } from "./apply_edit.ts";
import { globListTool } from "./glob_list.ts";
import { ipyRunTool } from "./ipy_run.ts";
import { subagentSpawnTool } from "./subagent.ts";
import { createHarnessTool } from "./harness.ts";
import { listSkillsTool, loadSkillTool, createSkillTool } from "./skills.ts";
import type { SeaTool } from "./types.ts";

export const allTools: SeaTool[] = [
  bashExecTool,
  readFileTool,
  writeFileTool,
  applyEditTool,
  globListTool,
  ipyRunTool,
  listSkillsTool,
  loadSkillTool,
  createSkillTool,
  subagentSpawnTool,
  createHarnessTool,
];

export const toolNames = allTools.map((t) => t.name);
