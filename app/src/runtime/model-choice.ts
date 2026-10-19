/**
 * Which model a run starts on, when the user said (`--model`) or did not.
 *
 * pi's own pick with nothing saved is the first provider in its list that has any
 * credential, and Bedrock heads that list: one AWS variable in the environment (a profile
 * name is enough) and a fresh install starts on a Bedrock model nobody chose, which doctor
 * then shows as ready. An explicit key for another provider is a better sign of intent.
 */
import { resolveCliModel, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";

export interface Choice {
  model?: Model<Api>;
  error?: string;
}

/** The default model saved in pi's settings.json, if any. */
function saved(agentDir: string): { provider?: string; id?: string } {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")) as { defaultProvider?: string; defaultModel?: string };
    return { provider: s.defaultProvider, id: s.defaultModel };
  } catch {
    return {};
  }
}

/**
 * `--model provider/id` (or a model name that is unambiguous) must exist and have credentials.
 * Without it nothing is chosen unless pi would start on Bedrock by default while another
 * provider is ready; `continuing` leaves a resumed session's own model alone.
 */
export function chooseModel(rt: ModelRuntime, o: { flag?: string; agentDir: string; continuing: boolean }): Choice {
  if (o.flag !== undefined) {
    const r = resolveCliModel({ cliModel: o.flag, modelRuntime: rt });
    if (!r.model) return { error: (r.error ?? `model ${o.flag} not found`).replace(" Use --list-models to see available models.", " Run mnemo and use /model to list them.") };
    if (!rt.hasConfiguredAuth(r.model.provider)) return { error: `no credentials for ${r.model.provider}: set its API key in the environment, or run mnemo and use /login` };
    return { model: r.model };
  }
  if (o.continuing) return {};
  const { provider, id } = saved(o.agentDir);
  const wanted = provider && id ? rt.getModel(provider, id) : undefined;
  if (wanted && rt.hasConfiguredAuth(wanted.provider)) return {};
  const ready = rt.getAvailableSnapshot();
  if (!ready.some((m) => m.provider === "amazon-bedrock")) return {};
  return { model: ready.find((m) => m.provider !== "amazon-bedrock") };
}
