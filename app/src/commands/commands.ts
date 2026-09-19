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
import { fetchModels, renderModels, setModel } from "../models/catalogue.ts";

export interface CommandContext {
  session: Session;
  home: string;
  provider?: string;
  model?: string;
  /** The configured model, spelled out for the catalogue line. */
  current?: string;
  /** The provider's key, when one is stored. */
  key?: string;
  /** Injected so a test never opens a socket. */
  fetchImpl?: typeof fetch;
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
  /**
   * Lines that need the network, resolved after the command returns.
   *
   * A catalogue fetch is a round trip; the command surface stays synchronous so
   * that everything about it remains testable without a server, and only the
   * part that genuinely needs the world goes async.
   */
  deferred?: () => Promise<string[]>;
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
      if (!ctx.provider) {
        return { lines: ["no provider yet — `/login` first, then `/model` lists what that key can run"] };
      }
      if (argument) {
        try {
          setModel(ctx.home, ctx.provider, argument);
          return { lines: [`${ctx.provider}: ${argument} is now the default`, "  it shows in the bar under the prompt"] };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return { lines: [`could not set that model: ${reason}`] };
        }
      }
      return {
        lines: [`${ctx.provider}: ${ctx.current ? `currently ${ctx.current}` : "no default chosen"}`, "asking for the catalogue…"],
        deferred: async () => {
          const answer = await fetchModels({ provider: ctx.provider!, key: ctx.key, fetchImpl: ctx.fetchImpl });
          return "error" in answer ? [`could not list models: ${answer.error}`] : renderModels(answer.models);
        },
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
