/**
 * Commands, which are not messages.
 *
 * This exists because of a loop: the interface said "run /login", the reader ran
 * `/login`, and it was submitted as a *message* — which produced "run /login".
 * Forever. An instruction that points at a command that does not exist is worse
 * than no instruction, and the fix is structural: anything starting with `/` is
 * a command and never becomes a turn.
 *
 * Two rules follow from that:
 *
 *  1. **A typo'd command never costs a model call.** `/modle` is an error, not a
 *     prompt, and it says so without reaching a provider.
 *  2. **A command that cannot do its job says what is missing** rather than
 *     appearing to work. Pretending is how the loop started.
 */
import type { Session } from "../session/session.ts";

export interface CommandContext {
  session: Session;
  home: string;
  provider?: string;
  model?: string;
  /** Leave the interface. */
  exit(): void;
}

export interface CommandResult {
  /** Lines to show. Empty means the command drew nothing itself. */
  lines: string[];
  /** True when the command ended the session. */
  exited?: boolean;
  /** When set, the interface asks for a secret for this provider. */
  beginSecret?: string;
}

/** The providers a key can be added for, in the order we suggest them. */
export const PROVIDERS = [
  { id: "openrouter", label: "OpenRouter", note: "one key, most models" },
  { id: "anthropic", label: "Anthropic", note: "Claude, direct" },
  { id: "openai", label: "OpenAI", note: "GPT, direct" },
  { id: "deepseek", label: "DeepSeek", note: "cheap, capable" },
  { id: "opencode-go", label: "Console Go", note: "OpenCode Go subscription" },
] as const;

const HELP: Array<[string, string]> = [
  ["/help", "this list"],
  ["/login", "add a provider — `/login` lists them, `/login <name>` adds one"],
  ["/model", "choose the default model for the configured provider"],
  ["/memory", "what the memory layer knows"],
  ["/quit", "leave"],
];

export function commandNames(): string[] {
  return HELP.map(([name]) => name);
}

/** The whole command surface, as the interface shows it. */
export function helpLines(): string[] {
  const width = Math.max(...HELP.map(([name]) => name.length));
  return ["commands:", ...HELP.map(([name, note]) => `  ${name.padEnd(width)}   ${note}`)];
}

export function runCommand(input: string, ctx: CommandContext): CommandResult {
  const text = input.trim();
  const [head, ...rest] = text.split(/\s+/);
  const name = (head ?? "").toLowerCase();
  const argument = rest.join(" ").trim();

  switch (name) {
    case "/help":
      return { lines: helpLines() };

    case "/quit":
    case "/exit":
      ctx.exit();
      return { lines: [], exited: true };

    case "/login":
      return login(argument, ctx);

    case "/model":
      // The catalogue comes from the provider's own API, which needs a key — so
      // this cannot invent a list, and saying so is the honest answer.
      if (!ctx.provider) {
        return { lines: ["no provider yet — `/login` first, then `/model` lists what that key can run"] };
      }
      return {
        lines: [
          `provider: ${ctx.provider}`,
          ctx.model ? `current model: ${ctx.model}` : "no default model chosen yet",
          "choosing from the catalogue lands next — it needs the provider's model list",
        ],
      };

    case "/memory":
      return { lines: ["memory: reading the sidecar — the panel lands next"] };

    case "":
      return { lines: [] };

    default:
      return { lines: [`no such command: ${name} — /help lists them`] };
  }
}

function login(argument: string, ctx: CommandContext): CommandResult {
  if (!argument) {
    return {
      lines: [
        "which provider? add a key with `/login <name>`:",
        ...PROVIDERS.map((p) => `  ${p.id.padEnd(12)} ${p.label} — ${p.note}`),
      ],
    };
  }

  const known = PROVIDERS.find((p) => p.id === argument.toLowerCase());
  if (!known) {
    return { lines: [`unknown provider: ${argument}`, ...PROVIDERS.map((p) => `  ${p.id}`)] };
  }

  return {
    lines: [
      `${known.label} — paste the key and press enter. It is not echoed and not kept in the transcript.`,
      `  ctrl+c cancels. It is stored in ${ctx.home}/auth.json`,
    ],
    beginSecret: known.id,
  };
}
