/**
 * The pi session runtime Mnemo runs on, in this process.
 *
 * pi owns the agent loop, the tools, sessions, compaction, skills, prompt
 * templates and provider auth; Mnemo adds its behaviour as inline extensions
 * and draws the interface. `AgentSessionRuntime` (not a bare `AgentSession`) so
 * `/new` and `/resume` can replace the active session.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getReadmePath,
  hasTrustRequiringProjectResources,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { enforceModels, loadManaged } from "../policy/managed.ts";

export interface RuntimeOptions {
  cwd: string;
  agentDir: string;
  /** Injected by tests and `--demo` (a runtime with the faux provider registered). */
  modelRuntime?: ModelRuntime;
  /** Forces the model, e.g. the faux one; otherwise pi's settings decide. */
  model?: Model<any>;
  /** Injected by tests (`SessionManager.inMemory`). */
  sessionManager?: SessionManager;
  /** Continue the most recent session in this directory. */
  continueRecent?: boolean;
  extensions?: InlineExtension[];
  /**
   * Whether the folder's own `.agents/` extensions, settings, prompts and skills may load.
   * Left out, a folder that carries any is trusted only if the user said so earlier.
   */
  trustProject?: boolean;
}

/**
 * Code that comes with a folder (`.agents/extensions/*.ts` runs inside this process, before
 * any approval) loads only when the user has trusted the folder. A folder with nothing of
 * the kind needs no decision. The answer is kept in pi's own `trust.json`, so it is shared
 * with pi and survives restarts.
 */
export function projectTrusted(cwd: string, agentDir: string, override?: boolean): boolean {
  if (override !== undefined) return override;
  if (!hasTrustRequiringProjectResources(cwd)) return true;
  return new ProjectTrustStore(agentDir).get(cwd) === true;
}

/** A managed policy's model list holds here, for every request this runtime sends. */
export async function createModelRuntime(agentDir: string): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
  return enforceModels(runtime, loadManaged());
}

/**
 * pi's system prompt sends the model to its README, docs/ and examples/ beside its
 * package. A compiled binary has none of them (pi takes the folder of the executable),
 * so the model was told to read files that do not exist. There, the section says where
 * the documentation really is; run from source, pi's own section stands.
 */
export function piDocsSection(readme = getReadmePath()): string | undefined {
  if (fs.existsSync(readme)) return undefined;
  return "Mnemo runs on pi, a coding agent harness. pi's documentation (extensions, skills, themes, prompt templates, models.json and custom providers, MCP, the SDK) is not installed with Mnemo; it is online at https://github.com/earendil-works/pi/tree/main/packages/coding-agent (docs/ and examples/). Read it only when the user asks about pi itself.";
}

const piDocs: InlineExtension = {
  name: "pi-docs",
  hidden: true,
  factory: (pi) => {
    const docs = piDocsSection();
    if (!docs) return;
    pi.on("before_agent_start", (event) => {
      event.systemPromptOptions.sections.docs = docs;
    });
  },
};

export async function startRuntime(options: RuntimeOptions): Promise<AgentSessionRuntime> {
  const modelRuntime = options.modelRuntime ?? (await createModelRuntime(options.agentDir));
  const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir: options.agentDir,
      modelRuntime,
      settingsManager: SettingsManager.create(cwd, options.agentDir, { projectTrusted: projectTrusted(cwd, options.agentDir, options.trustProject) }),
      // First, so extensions that build on the rendered prompt (memory recall) see the section it sets.
      resourceLoaderOptions: { extensionFactories: [piDocs, ...(options.extensions ?? [])] },
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model: options.model,
    });
    return { ...created, services, diagnostics: services.diagnostics };
  };
  const sessionManager =
    options.sessionManager ??
    (options.continueRecent ? SessionManager.continueRecent(options.cwd) : SessionManager.create(options.cwd));
  return createAgentSessionRuntime(factory, { cwd: options.cwd, agentDir: options.agentDir, sessionManager });
}
