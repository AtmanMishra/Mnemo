/**
 * @mnemo/memory — Mnemo's memory, detachable.
 *
 * One journal (the memsrv sidecar), many agents: Mnemo drives a
 * `MemorySession` from its pi extension; other agents attach through the
 * same session (hooks, an MCP server, or a transcript replayed after the
 * fact). Nothing here prints; everything returns text or notes.
 */
export { MemoryClient, type MemoryChild } from "./client.ts";
export { Credit } from "./credit.ts";
export { describeNode, summarizeMemory, type MemoryNode, type MemorySummary } from "./panel.ts";
export { findMemsrv, journalPath, memsrvName, mnemoHome } from "./paths.ts";
export { normalizeRemote, projectIdentity, type ProjectIdentity } from "./project.ts";
export { describeHit, DIRECTIVE, hitLine, profileBlock, recallMessage } from "./recall.ts";
export { readMemory, type MemoryReader } from "./read.ts";
export { redact } from "./redact.ts";
export {
  digest,
  parseReflection,
  recoveries,
  REFLECT_PROMPT,
  textOf,
  worthReflecting,
  type DigestInput,
  type Reflection,
  type ToolEvent,
} from "./reflect.ts";
export {
  factsOf,
  factValue,
  MemoryService,
  projectLabel,
  spawnMemsrv,
  USER_LABEL,
  type EdgeKind,
  type Hit,
  type ProfileFact,
  type Scope,
} from "./service.ts";
export {
  MemorySession,
  subjectOf,
  type MemoryNote,
  type Recalled,
  type Reflector,
  type RunEnd,
  type SessionOptions,
  type SkillOffer,
  type Source,
} from "./session.ts";
export { renderSkill, skillPath, writeSkill, type SkillScope } from "./skills.ts";
export {
  claudeCodeSessions,
  ingestClaudeCode,
  parseClaudeCode,
  replay,
  type IngestOptions,
  type IngestReport,
  type ReplayRun,
  type ReplaySession,
  type ReplayTool,
} from "./ingest/index.ts";
export { MCP_TOOLS, serveMcp, type McpOptions } from "./mcp.ts";
export { contextHook, type HookInput, type HookOptions } from "./hooks.ts";
