/**
 * The turn: pi, spawned, streamed, stoppable.
 *
 * This is the piece that turns a correct interface into an agent. Everything it
 * needs already existed and was tested in isolation — `runTurn` translates pi's
 * events into ours, the session paints them, the host routes submit/interrupt —
 * and what was missing was something that *is* a pi process.
 *
 * pi ships one: `RpcClient`, which spawns the agent in RPC mode and gives back a
 * typed API (`prompt`, `onEvent`, `abort`). It is loaded dynamically and by path
 * because the app package does not declare pi as a dependency yet: adding one
 * means an install step, and an install step means the interface cannot start
 * without network. That is a real deficiency and it is written down here rather
 * than hidden — the fix is a dependency in `app/package.json`, and it should
 * happen before this ships to anyone.
 *
 * The environment is not decoration. `MNEMO_APPROVAL_MODE=interactive` is what
 * tells the approval gate an "ask" has someone to ask; without it a child with no
 * TTY takes the fail-open path and the ask tier silently becomes allow. The child
 * inherits this process's environment with that one value *set*, never dropped.
 */
import type { TurnRunner } from "./host.ts";
import type { Session } from "./session.ts";
import { toSessionEvents, type PiLikeEvent } from "./pi.ts";
import { fileURLToPath } from "node:url";

/** The slice of pi's `RpcClient` this needs — so a test can be a plain object. */
export interface PiRpcLike {
  start(): Promise<void>;
  stop?(): Promise<void>;
  onEvent(listener: (event: PiLikeEvent) => void): () => void;
  prompt(message: string): Promise<void>;
  abort(): Promise<void>;
}

export interface PiRunnerOptions {
  /** Where the repo is, so the agent's own entry point can be found. */
  repoRoot: string;
  cwd: string;
  home: string;
  provider?: string;
  model?: string;
  /** Injected in tests; loaded from the agent's install in production. */
  client?: PiRpcLike;
}

/**
 * Where pi lives right now: the agent package's own install.
 *
 * Resolved at runtime rather than imported statically so the type checker does
 * not need a dependency the package does not have yet.
 */
const PI_ENTRY = "../../../agent/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

/**
 * pi's own CLI, beside its index.
 *
 * `RpcClient` will otherwise look for a `dist/cli.js` relative to whatever the
 * working directory happens to be — which meant it tried to spawn
 * `app/dist/cli.js` and failed with MODULE_NOT_FOUND. A spawn that depends on
 * where you ran it from is a spawn that works until someone runs it elsewhere.
 */
const PI_CLI = fileURLToPath(new URL("cli.js", new URL(PI_ENTRY, import.meta.url)));

interface RpcClientConstructor {
  new (options: Record<string, unknown>): PiRpcLike;
}

async function loadRpcClient(): Promise<RpcClientConstructor> {
  const module = (await import(new URL(PI_ENTRY, import.meta.url).href)) as {
    RpcClient: RpcClientConstructor;
  };
  return module.RpcClient;
}

export class PiTurnRunner implements TurnRunner {
  readonly #session: Session;
  readonly #client: PiRpcLike;
  #unsubscribe: (() => void) | undefined;
  #running = false;

  private constructor(session: Session, client: PiRpcLike) {
    this.#session = session;
    this.#client = client;
  }

  /** Spawn the agent and attach it to a session. */
  static async create(session: Session, options: PiRunnerOptions): Promise<PiTurnRunner> {
    const client =
      options.client ??
      new (await loadRpcClient())({
        cliPath: PI_CLI,
        cwd: options.cwd,
        provider: options.provider,
        model: options.model,
        env: {
          ...process.env,
          // Never inherited, always set: this process knows what mode its child
          // runs in. Without it, the ask tier fails open.
          MNEMO_APPROVAL_MODE: "interactive",
          MNEMO_HOME: options.home,
        },
      });

    const runner = new PiTurnRunner(session, client);
    await client.start();
    runner.#unsubscribe = client.onEvent((event) => {
      for (const translated of toSessionEvents(event)) session.apply(translated);
    });
    return runner;
  }

  /** True while a turn is in flight — the chrome reads this. */
  get running(): boolean {
    return this.#running;
  }

  async run(text: string): Promise<void> {
    this.#running = true;
    try {
      await this.#client.prompt(text);
    } finally {
      this.#running = false;
      this.#session.apply({ type: "turn-end" });
    }
  }

  interrupt(): void {
    // Fire and forget: ctrl+c must return the keyboard immediately, and the
    // events that follow an abort arrive on their own.
    void this.#client.abort().catch(() => {});
  }

  async stop(): Promise<void> {
    this.#unsubscribe?.();
    await this.#client.stop?.();
  }
}
