/**
 * What memory refuses to keep. Memory is injected into future prompts — of
 * this agent and of every other agent attached to it — so a fact is a
 * standing instruction. Text that tries to steer the agent, smuggle data out,
 * or hide characters from a reader is refused, wherever it came from (a
 * model's reflection on a transcript that quoted a poisoned web page, a tool
 * call, an MCP client).
 */
const RULES: [RegExp, string][] = [
  [/\b(ignore|disregard|forget|override|bypass)\b[\s\S]{0,60}\b(previous|prior|above|earlier|all|any|system|developer|your)\b[\s\S]{0,30}\b(instructions?|prompts?|rules?|messages?|guidelines?)\b/i, "tries to override instructions"],
  [/\byou\s+are\s+(now|no\s+longer)\b|\bact\s+as\s+(if|though)\s+you\b|\bnew\s+(system\s+)?instructions?\s*:/i, "tries to change who the agent is"],
  [/<\s*\/?\s*(system|assistant|user|tool)\b[^>]*>|\[\s*\/?\s*(INST|SYS)\s*\]|<\|im_(start|end)\|>/i, "carries prompt markup"],
  [/\b(curl|wget|fetch|invoke-webrequest|nc)\b[^\n]{0,120}\$\{?\w*(key|token|secret|password|credential)/i, "sends a secret somewhere"],
  [/\b(send|post|upload|exfiltrate|forward|email|append|attach|include|paste)\b[\s\S]{0,60}\b(api[ _-]?keys?|tokens?|secrets?|passwords?|credentials?|\.env|ssh keys?|id_rsa|id_ed25519|\.aws|auth\.json)\b/i, "sends a secret somewhere"],
  [/\b(curl|wget|iwr|invoke-webrequest)\b[^\n]{0,200}\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/i, "pipes a download into a shell"],
  [/\bfrom now on\b[\s\S]{0,80}\b(run|execute|curl|wget|download|send|upload)\b/i, "tries to set a standing order"],
  [/!\[[^\]]*\]\(\s*https?:\/\/[^)\s]*[?&=][^)]*\)/i, "embeds a remote image that can carry data out"],
  [/[\p{Cf}\u034f\u180e\ufe00-\ufe0f\u{E0000}-\u{E007F}]/u, "contains invisible characters"],
];

/** Lookalike letters (Cyrillic, Greek) folded to the Latin they imitate. */
const LOOKALIKE: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", х: "x", у: "y", і: "i", ј: "j", ѕ: "s", һ: "h", ԁ: "d", ԛ: "q", ԝ: "w", ɡ: "g",
  α: "a", ε: "e", ο: "o", ρ: "p", ν: "v", ι: "i", κ: "k", τ: "t", υ: "u", χ: "x",
};

/** What a reader sees: width forms and ligatures folded, lookalikes mapped, accents dropped. */
function seen(text: string): string {
  const folded = text.normalize("NFKC").replace(/\p{Mn}/gu, "");
  return folded.replace(/[^\x00-\x7f]/g, (c) => LOOKALIKE[c.toLowerCase()] ?? c);
}

/** Why this text may not be kept, or undefined when it may. */
export function unsafeMemory(text: string): string | undefined {
  // Both the text as written (invisible characters) and as read (everything else).
  const read = seen(text);
  for (const [re, why] of RULES) if (re.test(text) || re.test(read)) return why;
  return undefined;
}
