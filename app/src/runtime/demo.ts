/**
 * A scripted model for `mnemo --demo` and the tests: pi-ai's faux provider
 * registered in a real `ModelRuntime`, so the whole stack — pi's agent loop,
 * its real tools, sessions, the interface — runs with no key and no network.
 */
import * as fs from "node:fs";
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

export async function createFaux(agentDir: string, options: { tokensPerSecond?: number } = {}): Promise<Faux> {
  const faux = fauxProvider({
    provider: "mnemo-demo",
    models: [{ id: "demo-model", name: "demo", reasoning: true, contextWindow: 200_000 }],
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
  return dir;
}

export const DEMO_PROMPT = "add a retry to the fetch helper";

/** One turn: think, read the file, edit it, explain. */
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
  ];
}
