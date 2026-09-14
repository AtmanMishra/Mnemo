/**
 * 12.7 (audit 68846059): child processes spawned by tools get a scrubbed env.
 *
 * ensureAuthenticated() injects the stored provider key into THIS process's
 * env because pi's provider layer reads it there — that is fine for the agent
 * process itself. But every child we spawn (bash_exec, the ipy kernel,
 * MCP servers, the memsrv sidecar, sub-agents) inherits process.env verbatim,
 * so an approved `env` command — or any Python cell, MCP server or plugin —
 * could read the plaintext key and exfiltrate it.
 *
 * scrubChildEnv() drops every secret-shaped variable (name ends in
 * API_KEY / TOKEN / SECRET / PASSWORD / PASSWD / CREDENTIAL(S)) before the
 * env is handed to a child. The agent process keeps its own env untouched.
 *
 * Policy note: a sub-agent child re-authenticates from ~/.mnemo/auth.json
 * (ensureAuthenticated prefers env, then the store). A key that exists ONLY
 * in the parent's env therefore does not propagate to children — store the
 * key (mnemo-agent / login) if you use sub-agents.
 *
 * 21 (D6): childShellEnv() is the env every child SHELL gets. Besides the
 * credential scrub it publishes pi's documented session variables
 * (docs/environment-variables.md:26-45) — PI_SESSION_ID, PI_SESSION_FILE,
 * PI_PROVIDER, PI_MODEL, PI_REASONING_LEVEL — resolved from the live session,
 * and deletes any PI_* value inherited from a parent process first, so a
 * nested Mnemo can never hand its shells another session's metadata.
 *   pi injects these into its own bash/powershell tools; we ship our own
 * shell tools, so the injection is ours to do. The values describe the
 * session; PI_PROVIDER/PI_MODEL are what the model should be asked about,
 * never inferred from the system prompt.
 */

/** Env names whose value is a credential, whatever the value looks like. */
export const SECRET_ENV_NAME = /(^|_)(API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$/i;

/** The parent env minus every credential-shaped variable. */
export function scrubChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_ENV_NAME.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** The PI_* names pi documents for shell tools, in documentation order. */
export const PI_SESSION_ENV_NAMES = [
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
] as const;

/**
 * Live session facts published to child shells. Every field is optional: an
 * unknown value means the variable is omitted, never that a stale inherited
 * one is inherited (`PI_SESSION_FILE` is genuinely unset for ephemeral
 * sessions, per pi's docs).
 */
export interface PiSessionEnv {
  sessionId?: string | undefined;
  sessionFile?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  reasoningLevel?: string | undefined;
}

/**
 * Structural subset of pi's ExtensionContext (ExtensionContext in
 * @earendil-works/pi-coding-agent) — typed structurally so this module stays
 * dependency-free and tests can pass a plain object.
 */
export interface PiSessionContext {
  sessionManager?: {
    getSessionId?(): string;
    getSessionFile?(): string | undefined | null;
  } | undefined;
  model?: { provider?: string; id?: string } | undefined;
  thinkingLevel?: string | undefined;
}

/** Non-empty strings only — an empty value is "unknown", not "". */
function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Read the session facts out of pi's extension/tool context. A context that
 * throws on any accessor degrades to "nothing known" rather than killing the
 * tool call: shell metadata must never be the reason a command fails.
 * Unknown values are omitted entirely (never `undefined` keys), so a caller
 * can spread the result into an env without second-guessing it.
 */
export function sessionEnvFromContext(ctx: PiSessionContext | undefined): PiSessionEnv {
  if (!ctx) return {};
  try {
    const manager = ctx.sessionManager;
    const model = ctx.model;
    const out: PiSessionEnv = {};
    const sessionId = clean(manager?.getSessionId?.());
    if (sessionId !== undefined) out.sessionId = sessionId;
    const sessionFile = clean(manager?.getSessionFile?.());
    if (sessionFile !== undefined) out.sessionFile = sessionFile;
    const provider = clean(model?.provider);
    if (provider !== undefined) out.provider = provider;
    const modelId = clean(model?.id);
    if (modelId !== undefined) out.model = modelId;
    const reasoningLevel = clean(ctx.thinkingLevel);
    if (reasoningLevel !== undefined) out.reasoningLevel = reasoningLevel;
    return out;
  } catch {
    return {};
  }
}

/** The PI_* variables a session publishes, as env entries. */
export function piSessionEnvVars(session: PiSessionEnv | undefined): Record<string, string> {
  if (!session) return {};
  const out: Record<string, string> = {};
  const values: Array<[string, string | undefined]> = [
    ["PI_SESSION_ID", session.sessionId],
    ["PI_SESSION_FILE", session.sessionFile],
    ["PI_PROVIDER", session.provider],
    ["PI_MODEL", session.model],
    ["PI_REASONING_LEVEL", session.reasoningLevel],
  ];
  for (const [name, value] of values) {
    const v = clean(value);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/**
 * The environment for a child shell: scrubbed credentials, stale inherited
 * PI_* values deleted, then this session's values layered on top.
 */
export function childShellEnv(
  session?: PiSessionEnv | undefined,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out = scrubChildEnv(env);
  for (const name of PI_SESSION_ENV_NAMES) delete out[name];
  return { ...out, ...piSessionEnvVars(session) };
}

/** pi's process markers, and the values it documents for them. */
export const AGENT_MARKERS: Readonly<Record<string, string>> = {
  AI_AGENT: "pi",
  PI_CODING_AGENT: "true",
};

/**
 * Mark THIS process the way pi's own CLI/RPC entry points do
 * (docs/environment-variables.md:11-18), so every child — shell, kernel,
 * sub-agent — can identify pi as the launching agent. Set unconditionally,
 * exactly like pi: a nested agent inherits the marker it is running under.
 * Called by the mnemo shim (bin/mnemo.ts), which enters pi through its
 * library main() and would otherwise skip this.
 */
export function setAgentProcessMarkers(env: NodeJS.ProcessEnv = process.env): void {
  for (const [name, value] of Object.entries(AGENT_MARKERS)) env[name] = value;
}
