/**
 * pi's bash tool, with the model-provider keys taken out of every command's
 * environment (see runtime/env.ts). Registered under the same name, so it
 * replaces the built-in one and keeps the user's shell settings.
 */
import { createBashToolDefinition, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { childEnv, configuredKeys } from "../runtime/env.ts";
import { projectTrusted } from "../runtime/runtime.ts";
import type { Host } from "./host.ts";

export function shellExtension(host: Host) {
  return (pi: ExtensionAPI): void => {
    const tools = new Map<string, ReturnType<typeof createBashToolDefinition>>();
    const forCwd = (cwd: string) => {
      let tool = tools.get(cwd);
      if (!tool) {
        const settings = SettingsManager.create(cwd, host.agentDir, { projectTrusted: projectTrusted(cwd, host.agentDir) });
        tool = createBashToolDefinition(cwd, {
          commandPrefix: settings.getShellCommandPrefix(),
          shellPath: settings.getShellPath(),
          spawnHook: (spawn) => ({ ...spawn, env: childEnv(spawn.env, configuredKeys(host.agentDir)) }),
        });
        tools.set(cwd, tool);
      }
      return tool;
    };
    const base = forCwd(process.cwd());
    pi.registerTool({
      ...base,
      execute: (id, params, signal, onUpdate, ctx) => forCwd(ctx.cwd).execute(id, params, signal, onUpdate, ctx),
    });
  };
}
