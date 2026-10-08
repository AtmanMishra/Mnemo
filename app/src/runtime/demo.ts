/**
 * A scripted model for `mnemo --demo` and the tests: pi-ai's faux provider
 * registered in a real `ModelRuntime`, so the whole stack — pi's agent loop,
 * its real tools, sessions, the interface — runs with no key and no network.
 */
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type FauxProviderHandle,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";

export interface Faux {
  modelRuntime: ModelRuntime;
  faux: FauxProviderHandle;
}

export async function createFaux(agentDir: string, options: { tokensPerSecond?: number; strong?: boolean } = {}): Promise<Faux> {
  const faux = fauxProvider({
    provider: "mnemo-demo",
    models: [
      { id: "demo-model", name: "demo", reasoning: true, contextWindow: 200_000 },
      // A second model to escalate to, for the tests that need one.
      ...(options.strong ? [{ id: "demo-strong", name: "demo strong", reasoning: true, contextWindow: 200_000 }] : []),
    ],
    tokensPerSecond: options.tokensPerSecond,
  });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null });
  modelRuntime.registerNativeProvider(faux.provider);
  return { modelRuntime, faux };
}

const FETCH_BEFORE = `export async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
  return res.json();
}
`;

const OLD = `  const res = await fetch(url);
  if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
  return res.json();`;

const NEW = `  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (attempt === 3 || res.status < 500) throw new Error(\`HTTP \${res.status}\`);
    await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
  }`;

/** A throwaway project for the demo to work in. */
export function createDemoProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-demo-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "fetch.ts"), FETCH_BEFORE);
  // A repository, as real work is: the demo checks its change with git.
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.email=demo@mnemo", "-c", "user.name=demo", ...args], { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  return dir;
}

export const DEMO_PROMPT = "add a retry to the fetch helper";

/** What the reflection step "extracts" from the demo turn (the faux model's last answer). */
export const DEMO_REFLECTION = JSON.stringify({
  facts: [
    { scope: "project", key: "language", value: "TypeScript", source: "observed" },
    { scope: "project", key: "http helper", value: "getJson (src/fetch.ts) retries 5xx up to 3 times with backoff; 4xx fail fast", source: "observed" },
  ],
  episode: {
    goal: "add retries to the fetch helper",
    outcome: "done",
    done: "getJson in src/fetch.ts now retries server errors three times with exponential backoff",
    decisions: ["retry only 5xx so client errors still fail fast"],
    open: ["no test covers the retry path yet"],
  },
  fixes: [],
  skill: null,
});

/** One turn: think, read the file, edit it, explain — then the reflection call. */
export function demoScript(): FauxResponseStep[] {
  return [
    fauxAssistantMessage(
      [
        fauxThinking(
          "The user wants retries on the fetch helper. I should read it first to see how errors surface, then retry only on server errors so a 404 still fails fast.",
        ),
        fauxText("I'll look at the helper first."),
        fauxToolCall("read", { path: "src/fetch.ts" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxToolCall("edit", { path: "src/fetch.ts", edits: [{ oldText: OLD, newText: NEW }] })], {
      stopReason: "toolUse",
    }),
    // A change is checked before it is called done (Mnemo sends a run back that skips this).
    fauxAssistantMessage([fauxText("Checking the change."), fauxToolCall("bash", { command: "git diff --check && git diff --stat" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(
      fauxText(
        [
          "Done — `getJson` now retries **server errors** up to three times:",
          "",
          "- `5xx` responses back off exponentially (400 ms, 800 ms)",
          "- `4xx` responses still fail on the first try",
          "",
          "```ts",
          "await getJson(\"https://api.example.com/items\");",
          "```",
        ].join("\n"),
      ),
    ),
    fauxAssistantMessage(fauxText(DEMO_REFLECTION)),
  ];
}
