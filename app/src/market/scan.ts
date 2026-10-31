/**
 * Read a skill for what it would make the agent do before it is trusted.
 *
 * The rules are a subset of NVIDIA SkillSpector's static patterns
 * (https://github.com/NVIDIA/SkillSpector, Apache-2.0), ported to JavaScript regular expressions
 * and kept under their rule ids so a finding here means the same as one in a SkillSpector report:
 * the ones that are rarely innocent in a skill (instructions that override the system prompt,
 * hidden text, shipping the conversation or credentials out, remote code piped into a shell,
 * obfuscated execution, reverse shells, jailbreak framing). They read text; nothing in the skill
 * runs. When the `skillspector` program itself is installed, `scanSkill` also runs it (static
 * analysis only, see skillspector.ts) and adds what it finds.
 *
 * A finding is a reason to read the skill, not proof of malice: a security skill quotes these
 * phrases on purpose. HIGH and CRITICAL stop an install until the user says `--force`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { runSkillspector, type SpectorRunner } from "./skillspector.ts";

export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  /** Relative to the skill's folder, `/`-separated. */
  file: string;
  line: number;
  /** What matched, short and with invisible characters spelled out. */
  match: string;
  /** "mnemo" for the rules here, "skillspector" for the program. */
  by: string;
}

interface Rule {
  id: string;
  severity: Severity;
  message: string;
  patterns: RegExp[];
}

const r = (s: string) => new RegExp(s, "gi");
/** A shell command: the command name as written (lowercase, a word of its own), the rest in any case. */
const sh = (s: string) => new RegExp(String.raw`(?<![\w.-])` + s, "g");

const RULES: Rule[] = [
  {
    id: "P1",
    severity: "HIGH",
    message: "tells the agent to override its instructions or safety rules",
    patterns: [
      r(String.raw`ignore\s+(?:all\s+)?previous\s+instructions?`),
      r(String.raw`ignore\s+(?:all\s+)?(?:safety|security)\s+(?:rules?|constraints?|guidelines?)`),
      r(String.raw`override\s+(?:safety|security|system)`),
      r(String.raw`bypass\s+(?:safety|security|restrictions?|constraints?)`),
      r(String.raw`disregard\s+(?:all\s+)?(?:previous|safety|security)`),
      r(String.raw`forget\s+(?:all\s+)?(?:previous|your)\s+instructions?`),
      r(String.raw`you\s+are\s+now\s+(?:in\s+)?(?:jailbreak|unrestricted|unfiltered)\s+mode`),
      r(String.raw`do\s+not\s+follow\s+(?:any|your|the)\s+(?:rules?|guidelines?)`),
    ],
  },
  {
    id: "P2",
    severity: "HIGH",
    message: "hides text from a reader: bidirectional control characters reorder what is shown",
    patterns: [/[\u202a-\u202e\u2066-\u2069]/g],
  },
  {
    id: "P2",
    severity: "MEDIUM",
    message: "hides text from a reader: zero-width characters, or an HTML comment with instructions in it",
    // A byte-order mark at the very start of a file is ordinary; one anywhere else is not.
    patterns: [/(?<!^)[\u200b-\u200d\u2060\ufeff]|^[\u200b-\u200d\u2060]/g, /<!--(?!-?>)(?:(?!--!?>)[\s\S])*?\b(?:ignore|instructions?|system\s+prompt|transmit|exfiltrate|send\s+(?:the|all|it|them))\b(?:(?!--!?>)[\s\S])*?--!?>/gi],
  },
  {
    id: "P3",
    severity: "HIGH",
    message: "tells the agent to send the conversation or the user's data somewhere",
    patterns: [
      r(String.raw`(?:send|transmit|upload|post|forward)\s+(?:the\s+)?(?:conversation|context|chat|history|messages?)\s+to\b`),
      r(String.raw`(?:send|transmit|upload|post)\s+(?:all\s+)?(?:user\s+)?(?:data|information|input|files?)\s+to\s+(?:https?://|external)`),
      r(String.raw`(?:copy|extract|collect)\s+(?:the\s+)?(?:conversation|context|session)\s+(?:and\s+)?(?:send|upload|transmit)`),
      r(String.raw`(?:call|notify|ping|hit)\s+(?:this\s+)?(?:webhook|endpoint|url|api)\s+with\s+(?:the\s+)?(?:user|conversation|context)`),
      r(String.raw`(?:silently|quietly|secretly|covertly)\s+(?:send|transmit|log|record|upload)`),
      r(String.raw`without\s+(?:telling|informing|notifying)\s+(?:the\s+)?user[^\n]*?(?:send|transmit|upload)`),
    ],
  },
  {
    id: "E2",
    severity: "HIGH",
    message: "collects secrets from the environment",
    patterns: [
      r(String.raw`env\s*\|\s*grep\s+(?:-i\s+)?(?:key|secret|token|password)`),
      r(String.raw`(?:extract|harvest|gather)\s+(?:api\s+)?keys?\s+from\s+(?:the\s+)?environment`),
      r(String.raw`collect\s+(?:all\s+)?(?:environment\s+variables?|env\s+vars?)`),
    ],
  },
  {
    id: "PE3",
    severity: "HIGH",
    message: "reads credential files: SSH keys, cloud or git credentials, the password database, browser logins",
    patterns: [
      sh(String.raw`(?:cat|less|more|head|tail|base64|xxd|cp|scp|open)\s+(?:-\S+\s+)*["']?(?:~|\$HOME|/home/\w+|/Users/\w+)?/?\.(?:ssh/id_\w+|aws/credentials|git-credentials|netrc)\b`),
      r(String.raw`open\s*\(\s*[^)\n]*\.(?:ssh/id_\w+|aws/credentials|git-credentials)\b`),
      r(String.raw`/etc/shadow`),
      r(String.raw`(?:Chrome|Firefox|Safari)/[^\n]*?(?:Cookies|Login Data|key4\.db)`),
      r(String.raw`read\s+(?:the\s+)?(?:user'?s\s+)?(?:ssh|private)\s+keys?`),
    ],
  },
  {
    id: "PE3",
    severity: "MEDIUM",
    message: "names a credential file: SSH keys, cloud or git credentials",
    patterns: [r(String.raw`\.ssh/(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)\b(?!\.pub)`), r(String.raw`\.aws/credentials`), r(String.raw`\.git-credentials`), r(String.raw`application_default_credentials\.json`)],
  },
  {
    id: "AS1",
    severity: "HIGH",
    message: "reads another agent's configuration or saved login",
    patterns: [
      r(String.raw`~?/\.(?:claude|codex|gemini|continue|mnemo)/(?:[\w-]+/)*(?:config|settings?|credentials?|auth)(?:\.(?:json|ya?ml|toml))?\b`),
      sh(String.raw`(?:cat|less|head|tail|grep|find|ls)\s+(?:-\S+\s+)*["']?\S*\.(?:claude|codex|gemini|mnemo)/`),
    ],
  },
  {
    id: "AS2",
    severity: "HIGH",
    message: "reads MCP server configuration, where other tools' tokens live",
    patterns: [
      r(String.raw`open\s*\(\s*['"][^'"]*mcp(?:_config)?\.json['"]`),
      sh(String.raw`(?:cat|less|head|grep|jq)\s+(?:-\S+\s+)*(?:['"][^'"\n]*['"]\s+)?["']?\S*mcp(?:_config)?\.json`),
      r(String.raw`\.(?:claude|codex|gemini|mnemo|agents)/mcp(?:_config)?\.json`),
      r(String.raw`(?:read|access|load|inspect)\s+(?:the\s+)?mcp(?:\.json|_config)?\s+(?:file|config(?:uration)?|settings?)`),
    ],
  },
  {
    id: "SC2",
    severity: "HIGH",
    message: "downloads code and runs it unread",
    patterns: [
      r(String.raw`\b(?:curl|wget)\s+[^|\s][^|\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b`),
      r(String.raw`\b(?:curl|wget)\s+[^|\s][^|\n]*\|\s*(?:sudo\s+)?(?:python3?|node|ruby|perl)\b`),
      r(String.raw`\bcurl\s+[^&\n]*-o\s+\S+\s*&&\s*(?:sudo\s+)?(?:ba)?sh\b`),
      r(String.raw`\bwget\s+[^&\n]*-O\s+\S+\s*&&\s*(?:sudo\s+)?(?:ba)?sh\b`),
      r(String.raw`(?:exec|eval)\s*\(\s*(?:urllib|requests|httpx)\.[^)\n]+\.(?:read|text|content)`),
      r(String.raw`eval\s*\(\s*(?:await\s+)?fetch\s*\(`),
      r(String.raw`\b(?:iwr|Invoke-WebRequest|irm|Invoke-RestMethod)\b[^|\n]*\|\s*(?:iex|Invoke-Expression)\b`),
    ],
  },
  {
    id: "SC3",
    severity: "HIGH",
    message: "runs obfuscated code (decoded from base64, hex or compressed bytes)",
    patterns: [
      r(String.raw`(?:exec|eval)\s*\(\s*(?:base64\.)?b64decode\s*\(`),
      r(String.raw`exec\s*\(\s*(?:marshal\.loads|bytes\.fromhex|bytearray\.fromhex|(?:zlib|gzip)\.decompress)\s*\(`),
      r(String.raw`exec\s*\(\s*codecs\.decode\s*\([^)\n]*['"]hex['"]\s*\)`),
      r(String.raw`(?:eval|new\s+Function)\s*\(\s*atob\s*\(`),
      r(String.raw`base64\s+(?:-d|--decode)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b`),
      r(String.raw`decode\s+(?:this|the)\s+(?:base64|hex)\s+(?:and\s+)?(?:run|execute)`),
    ],
  },
  {
    id: "YR1",
    severity: "CRITICAL",
    message: "opens a reverse shell",
    patterns: [
      r(String.raw`(?:ba)?sh\s+-i\s+[>&]+\s*/dev/(?:tcp|udp)/`),
      r(String.raw`\bnc(?:at)?\s+(?:-\w+\s+)*-e\s+/bin/(?:ba)?sh\b`),
      r(String.raw`mkfifo\s+\S+[^\n]*\|\s*(?:/bin/)?(?:ba)?sh\s+-i[^\n]*\|\s*nc\b`),
    ],
  },
  {
    id: "SSRF1",
    severity: "HIGH",
    message: "reaches the cloud metadata service, which hands out the machine's credentials",
    patterns: [r(String.raw`169\.254\.169\.254`), r(String.raw`metadata\.google\.internal`), r(String.raw`100\.100\.100\.200`)],
  },
  {
    id: "AR3",
    severity: "HIGH",
    message: "jailbreak framing: tells the agent it has no rules",
    patterns: [
      r(String.raw`\byou\s+have\s+no\s+(?:restrictions?|limitations?|filters?|rules?|guidelines?|boundaries|limits)\b`),
      r(String.raw`\bnot\s+bound\s+by\s+(?:any\s+)?(?:rules?|policy|policies|guidelines?|restrictions?|openai|anthropic)\b`),
      r(String.raw`\bdo\s+anything\s+now\b`),
      r(String.raw`\bno\s+(?:content\s+)?(?:policy|policies|filters?|restrictions?)\s+appl(?:y|ies)\b`),
    ],
  },
  {
    id: "AR1",
    severity: "MEDIUM",
    message: "tells the agent never to refuse",
    patterns: [
      r(String.raw`\b(?:never|do\s+not|don'?t)\s+(?:ever\s+)?(?:refuse|decline)\b`),
      r(String.raw`\byou\s+(?:must|will|should|can)\s*(?:not|never)\s+(?:refuse|decline|say\s+no)\b`),
      r(String.raw`\bno\s+request\s+is\s+(?:off[- ]limits|forbidden)\b`),
    ],
  },
  {
    id: "E1",
    severity: "MEDIUM",
    message: "sends data to an address outside the machine",
    patterns: [
      r(String.raw`\bcurl\s+[^|\n]*(?:-d|--data|--data-raw|--data-binary|-F|--form|-T|--upload-file)\s+[^\n]*https?://`),
      r(String.raw`\bwget\s+[^|\n]*--post-(?:data|file)`),
      r(String.raw`requests\s*\.\s*(?:post|put)\s*\(\s*['"]https?://`),
    ],
  },
  {
    id: "RA2",
    severity: "MEDIUM",
    message: "makes itself persist: cron jobs, login scripts, services",
    patterns: [
      r(String.raw`crontab\s+(?:-[el]\b|[^\n]*>>?\s*/)`),
      r(String.raw`>>\s*~?/?(?:\$HOME/)?\.(?:bashrc|zshrc|profile|bash_profile)\b`),
      r(String.raw`(?:add|write|append|install)\s+(?:to|into)\s+(?:~/)?\.(?:bashrc|zshrc|profile|bash_profile)\b`),
      r(String.raw`\b(?:launchctl\s+load|reg\s+add\s+HK\w+\\[^\n]*\\Run\b)`),
    ],
  },
];

const RANK: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

const MAX_FILES = 300;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FINDINGS = 200;
const SKIP = new Set([".git", "node_modules"]);

/** What matched, at most 80 characters, with invisible and control characters made visible. */
export function shown(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  const cut = one.length > 80 ? `${one.slice(0, 77)}…` : one;
  return cut.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Findings in one file's text. `file` is the name reported. */
export function scanText(text: string, file: string): Finding[] {
  const out: Finding[] = [];
  const lineAt = (i: number) => text.slice(0, i).split("\n").length;
  for (const rule of RULES)
    for (const re of rule.patterns) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        out.push({ rule: rule.id, severity: rule.severity, message: rule.message, file, line: lineAt(m.index), match: shown(m[0]), by: "mnemo" });
        if (out.length >= MAX_FINDINGS) break;
      }
    }
  // A rule kept at two severities (PE3, P2) reports a line once, at the worse one.
  const worst = new Map<string, number>();
  for (const f of out) worst.set(`${f.rule}:${f.line}`, Math.max(worst.get(`${f.rule}:${f.line}`) ?? 0, RANK[f.severity]));
  return out.filter((f) => RANK[f.severity] === worst.get(`${f.rule}:${f.line}`)).slice(0, MAX_FINDINGS);
}

/** The text files under `dir` (relative, `/`), skipping links, binaries and anything too large. */
function textFiles(dir: string, rel = "", acc: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(e.name) || acc.length >= MAX_FILES) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) textFiles(dir, r, acc);
    else if (e.isFile()) acc.push(r);
  }
  return acc;
}

/** Mnemo's own rules over every text file of the skill in `dir` (or over one file). */
export function scanBuiltin(target: string): Finding[] {
  const st = fs.statSync(target);
  const dir = st.isDirectory() ? target : path.dirname(target);
  const files = st.isDirectory() ? textFiles(target) : [path.basename(target)];
  const out: Finding[] = [];
  for (const f of files) {
    const full = path.join(dir, f);
    if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
    const bytes = fs.readFileSync(full);
    if (bytes.subarray(0, 8192).includes(0)) continue;
    out.push(...scanText(bytes.toString("utf8"), f));
    if (out.length >= MAX_FINDINGS) break;
  }
  return out;
}

export interface ScanResult {
  findings: Finding[];
  /** Which scanners read it: "mnemo", and "skillspector" when that ran. */
  by: string[];
  /** Why SkillSpector, though installed, gave nothing. */
  note?: string;
}

export interface ScanOptions {
  /** The `skillspector` program; undefined looks for it on PATH, null leaves it out. */
  skillspector?: string | null;
  runner?: SpectorRunner;
}

/** Mnemo's rules, plus SkillSpector's static analysis when it is installed. */
export function scanSkill(dir: string, o: ScanOptions = {}): ScanResult {
  const findings = scanBuiltin(dir);
  const by = ["mnemo"];
  if (o.skillspector === null) return { findings, by };
  const spector = runSkillspector(dir, { bin: o.skillspector, runner: o.runner });
  if (!spector) return { findings, by };
  if ("error" in spector) return { findings, by, note: `skillspector did not finish: ${spector.error}` };
  // The same rule on the same line from both is one finding; keep SkillSpector's wording.
  const theirs = new Set(spector.findings.map((f) => `${f.rule}:${f.file}:${f.line}`));
  return { findings: [...findings.filter((f) => !theirs.has(`${f.rule}:${f.file}:${f.line}`)), ...spector.findings], by: [...by, "skillspector"] };
}

/** The findings that stop an install: HIGH and CRITICAL. */
export const blocking = (findings: Finding[]): Finding[] => findings.filter((f) => RANK[f.severity] >= RANK.HIGH);

/** One line per finding, worst first. */
export function formatFindings(findings: Finding[], indent = "  "): string[] {
  return [...findings]
    .sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.file.localeCompare(b.file) || a.line - b.line)
    .map((f) => `${indent}${f.severity.padEnd(8)} ${f.rule.padEnd(5)} ${f.file}:${f.line}  ${f.message}: ${f.match}${f.by === "mnemo" ? "" : ` [${f.by}]`}`);
}

/** The folders holding a SKILL.md: `dir` itself, or its immediate subfolders. */
export function skillFolders(dir: string): string[] {
  if (fs.existsSync(path.join(dir, "SKILL.md"))) return [dir];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "SKILL.md")))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * For the question a folder's `.agents/` asks before it loads: what Mnemo's own rules find in the
 * skills it ships, in one sentence, or undefined when they find nothing worth stopping for.
 */
export function projectSkillsWarning(cwd: string): string | undefined {
  const dir = path.join(cwd, ".agents", "skills");
  const hits = skillFolders(dir).flatMap((d) => {
    try {
      return blocking(scanBuiltin(d)).map((f) => path.basename(d));
    } catch {
      return [];
    }
  });
  if (!hits.length) return undefined;
  const names = [...new Set(hits)];
  return `Its skill${names.length === 1 ? "" : "s"} ${names.join(", ")} ${names.length === 1 ? "has" : "have"} ${hits.length} high-risk finding${hits.length === 1 ? "" : "s"} (mnemo skills scan .agents/skills lists them).`;
}
