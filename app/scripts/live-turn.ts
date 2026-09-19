#!/usr/bin/env bun
/**
 * A real turn through the spine.
 *
 * pi's loop, our event vocabulary, our transcript, a real provider, and every
 * frame printed as it is painted. This is the proof the adapter and the session
 * work against something other than a fixture — and it is a script rather than a
 * test because it needs a key and a network, which a test must never need.
 *
 *   bun app/scripts/live-turn.ts "say hello" [--width 88]
 *
 * Credentials: the provider key in `~/.mnemo/auth.json` is exported into the
 * environment before the session is created, which is what the application
 * itself will do during onboarding. The provider → variable mapping is the one
 * from the old store, repeated here on purpose: this is a probe, and a probe
 * that imports the thing it is probing proves less. It moves into
 * `app/src/auth/` when that phase lands.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { collectFacts, mnemoHome } from "../src/facts.ts";
import { runTurn } from "../src/session/pi.ts";
import { Session } from "../src/session/session.ts";

const ENV_KEY_BY_PROVIDER: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  opencode: "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
};

const args = process.argv.slice(2);
const widthIndex = args.indexOf("--width");
const width = widthIndex >= 0 ? Number(args[widthIndex + 1]) : 88;
const prompt = args.filter((a, i) => i !== widthIndex && i !== widthIndex + 1)[0] ??
  "In one sentence: what is this project?";

const home = mnemoHome();
const store = JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as {
  defaultProvider?: string;
  providers?: Record<string, { key?: string; accessToken?: string; defaultModel?: string }>;
};
const provider = store.defaultProvider ?? Object.keys(store.providers ?? {})[0];
const entry = store.providers?.[provider ?? ""];
const key = entry?.key ?? entry?.accessToken;
const envName = provider ? ENV_KEY_BY_PROVIDER[provider] : undefined;
if (!key || !envName) {
  console.error(
    `no usable credential: provider=${provider ?? "(none)"} — run the interface and /login first`,
  );
  process.exit(1);
}
process.env[envName] = key;

const facts = collectFacts();
console.error(`· provider ${provider}${entry?.defaultModel ? ` / ${entry.defaultModel}` : ""}`);
console.error(`· runtime  ${facts.runtime}`);

const { session: piSession } = await createAgentSession({
  cwd: process.cwd(),
  ...(entry?.defaultModel ? {} : {}),
});

// Which model pi actually resolved is not the same question as which provider
// our store names: pi reads its own settings, and a 401 is much easier to read
// once you know who the request was addressed to.
const resolved = piSession.model as { provider?: string; id?: string } | undefined;
console.error(`· pi model ${resolved?.provider ?? "?"}/${resolved?.id ?? "?"}`);

const session = new Session({ keepLive: 24 });
let frames = 0;
const seen: string[] = [];
/** The most recent frame's live region. A terminal shows scrollback *plus* this;
 *  printing only the scrollback made a turn with everything still live look
 *  like a turn that produced nothing. */
let live: readonly string[] = [];

// `--trace` prints pi's own events as they arrive. Without it, a turn that
// produces nothing looks identical to a turn whose events were not recognised,
// and those are very different problems.
if (args.includes("--trace")) {
  piSession.subscribe((event) => {
    const inner = (event as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent;
    const message = (event as {
      message?: { role?: string; errorMessage?: string; content?: unknown };
    }).message;
    console.error(`  pi> ${event.type}${inner?.type ? ` / ${inner.type}` : ""}`);
    // An empty answer and a rejected request look the same from the outside:
    // both are a message that arrives with nothing in it. Print what it holds.
    if (message) {
      const parts = Array.isArray(message.content) ? message.content.length : 0;
      console.error(
        `      role=${message.role} parts=${parts}` +
          (message.errorMessage ? ` error=${message.errorMessage}` : "") +
          (parts === 0 ? ` content=${JSON.stringify(message.content)}` : ""),
      );
    }
  });
}

await runTurn(piSession, session, prompt, {
  width,
  onFrame: (frame) => {
    frames += 1;
    live = frame.viewport;
  },
  onEvent: (event) => {
    seen.push(event.type);
    if (event.type === "tool-start" || event.type === "tool-end") {
      console.error(`· ${event.type}${"name" in event ? ` ${event.name}` : ""}`);
    }
  },
});

// What the terminal would be showing: everything that scrolled past, then the
// live region. Printed in order, exactly as the transcript reported it.
console.log([...session.transcript.history, ...live].join("\n"));
console.log(
  `\n— ${frames} frames, ${seen.filter((t) => t === "assistant-delta").length} deltas, ` +
    `${seen.filter((t) => t === "tool-start").length} tool call(s)`,
);

piSession.dispose();
