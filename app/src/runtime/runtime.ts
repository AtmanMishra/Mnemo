/**
 * The pi session runtime Mnemo runs on, in this process.
 *
 * pi owns the agent loop, the tools, sessions, compaction, skills, prompt
 * templates and provider auth; Mnemo adds its behaviour as inline extensions
 * and draws the interface. `AgentSessionRuntime` (not a bare `AgentSession`) so
 * `/new` and `/resume` can replace the active session.
 */
import * as path from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
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
   * Whether the folder's own `.pi/` extensions, settings, prompts and skills may load.
   * Left out, a folder that carries any is trusted only if the user said so earlier.
   */
  trustProject?: boolean;
}

/**
 * Code that comes with a folder (`.pi/extensions/*.ts` runs inside this process, before
 * any approval) loads only when the user has trusted the folder. A folder with nothing of
 * the kind needs no decision. The answer is kept in pi's own `trust.json`, so it is shared
 * with pi and survives restarts.
 */
export function projectTrusted(cwd: string, agentDir: string, override?: boolean): boolean {
  if (override !== undefined) return override;
  if (!hasTrustRequiringProjectResources(cwd)) return true;
  return new ProjectTrustStore(agentDir).get(cwd) === true;
}

export async function createModelRuntime(agentDir: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
}

export async function startRuntime(options: RuntimeOptions): Promise<AgentSessionRuntime> {
  const modelRuntime = options.modelRuntime ?? (await createModelRuntime(options.agentDir));
  const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir: options.agentDir,
      modelRuntime,
      settingsManager: SettingsManager.create(cwd, options.agentDir, { projectTrusted: projectTrusted(cwd, options.agentDir, options.trustProject) }),
      resourceLoaderOptions: { extensionFactories: options.extensions ?? [] },
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
