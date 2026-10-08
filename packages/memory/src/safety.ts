/**
 * What memory refuses to keep. Memory is injected into future prompts — of
 * this agent and of every other agent attached to it — so a fact is a
 * standing instruction. Text that tries to steer the agent, smuggle data out,
 * or hide characters from a reader is refused, wherever it came from (a
 * model's reflection on a transcript that quoted a poisoned web page, a tool
 * call, an MCP client).
 */
const RULES: [RegExp, string][] = [
  [/\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|system|developer)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|messages?)\b/i, "tries to override instructions"],
  [/\byou are (now|no longer)\b|\bact as (if|though) you\b|\bnew (system )?instructions?:/i, "tries to change who the agent is"],
  [/<\/?(system|assistant|user|tool)[^>]*>|\[\/?(INST|SYS)\]|<\|im_(start|end)\|>/i, "carries prompt markup"],
  [/\b(curl|wget|fetch|invoke-webrequest|nc)\b[^\n]{0,120}\$\{?\w*(key|token|secret|password|credential)/i, "sends a secret somewhere"],
  [/\b(send|post|upload|exfiltrate|forward|email)\b[^.\n]{0,60}\b(api[ _-]?keys?|tokens?|secrets?|passwords?|credentials?|\.env|ssh keys?)\b[^.\n]{0,40}\b(to|into)\b/i, "sends a secret somewhere"],
  [/[​-‏‪-‮⁠-⁤﻿\u{E0000}-\u{E007F}]/u, "contains invisible characters"],
];

/** Why this text may not be kept, or undefined when it may. */
export function unsafeMemory(text: string): string | undefined {
  for (const [re, why] of RULES) if (re.test(text)) return why;
  return undefined;
}
