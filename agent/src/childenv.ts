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
 * key (mnemo-agent /login) if you use sub-agents.
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
