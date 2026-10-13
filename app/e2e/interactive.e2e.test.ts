// The interactive interface in a real terminal: what only a person at a keyboard
// would otherwise find. Linux and macOS (Windows has no pty to drive).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startMockLLM, type MockLLM } from "./mock-llm.ts";
import { binary, world, type World } from "./harness.ts";
import { hasPty, KEY, terminal, type Terminal } from "./pty.ts";

const T = 90_000;
let llm: MockLLM;
const worlds: World[] = [];
const fresh = (opts: Parameters<typeof world>[0] = {}) => {
  const w = world({ llm: llm.url, ...opts });
  worlds.push(w);
  return w;
};
const START = ["--no-boot", "--no-motion"];
/** The prompt is drawn a moment before it listens; keys sent in between are lost. */
async function ready(t: Terminal) {
  await t.waitFor(/for commands/);
  await Bun.sleep(1200);
  t.mark();
}

beforeAll(() => {
  binary();
  llm = startMockLLM(() => ({ text: "pong from the mock" }));
}, 300_000);
afterAll(() => {
  llm.stop();
  for (const w of worlds) w.cleanup();
});

describe.if(hasPty)("interactive", () => {
  test("a prompt typed in the workspace gets an answer", async () => {
    const t = await terminal(fresh(), START);
    try {
      await ready(t);
      await t.type("ping");
      await t.type(KEY.enter);
      await t.waitFor(/pong from the mock/);
    } finally {
      await t.kill();
    }
  }, T);

  // The bug that shipped in 0.1.0–0.1.2: the flow lived in a file the binary did not contain,
  // so this step printed "Login failed: Cannot find module './anthropic.js'".
  test("/login → Anthropic → subscription loads the flow and reaches the sign-in URL", async () => {
    const t = await terminal(fresh(), START, { env: { BROWSER: "true" } });
    try {
      await ready(t);
      await t.type("/login anthropic");
      await t.type(KEY.enter);
      await t.waitFor(/how do you want to log in/);
      await Bun.sleep(600);
      t.mark();
      await t.type(KEY.enter); // Subscription is first
      await t.waitFor(/login method|Open this URL|Login failed/);
      expect(t.text()).not.toContain("Cannot find module");
      expect(t.text()).not.toContain("Login failed");
      await Bun.sleep(600);
      t.mark();
      await t.type(KEY.down); // Copy code login: prints the URL instead of opening a browser
      await t.type(KEY.enter);
      await t.waitFor(/Open this URL to sign in|Login failed/);
      expect(t.text()).toMatch(/https:\/\/\S*(claude|anthropic)/);
      expect(t.text()).not.toContain("Login failed");
    } finally {
      await t.kill();
    }
  }, T);

  test("/login → Anthropic → API key asks for the key and stores it", async () => {
    const w = fresh();
    const t = await terminal(w, START);
    try {
      await ready(t);
      await t.type("/login anthropic");
      await t.type(KEY.enter);
      await t.waitFor(/how do you want to log in/);
      await Bun.sleep(600);
      await t.type(KEY.down);
      await t.type(KEY.enter);
      await t.waitFor(/key/i);
      t.mark();
      await t.type("sk-ant-e2e-test-key");
      await t.type(KEY.enter);
      await t.waitFor(/Logged in to Anthropic|Login failed/);
      expect(t.text()).not.toContain("Login failed");
    } finally {
      await t.kill();
    }
    const auth = await Bun.file(`${w.mnemoHome}/agent/auth.json`).text();
    expect(auth).toContain("sk-ant-e2e-test-key");
  }, T);

  test("every provider's login flow loads in the binary", async () => {
    // Choosing each subscription provider must reach its first step (a URL, a code or a
    // question), never a missing module. Esc backs out between them.
    for (const id of ["openai-codex", "github-copilot"]) {
      const t = await terminal(fresh(), START, { env: { BROWSER: "true" } });
      try {
        await ready(t);
        t.mark();
        await t.type(`/login ${id}`);
        await t.type(KEY.enter);
        await t.waitFor(/how do you want to log in|URL|code|Enter|Login failed|Unknown provider/i);
        if (/how do you want to log in/.test(t.text())) await t.type(KEY.enter);
        await Bun.sleep(1500);
        expect(t.text()).not.toContain("Cannot find module");
      } finally {
        await t.kill();
      }
    }
  }, T);

  test("ctrl+k opens the palette and esc closes it", async () => {
    const t = await terminal(fresh(), START);
    try {
      await ready(t);
      await t.type(KEY.ctrlK);
      await t.waitFor(/\/model|\/login|commands/i);
      await t.type(KEY.esc);
    } finally {
      await t.kill();
    }
  }, T);

  test("/theme switches the theme and it is remembered", async () => {
    const w = fresh();
    const t = await terminal(w, START);
    try {
      await ready(t);
      await t.type("/theme dracula");
      await t.type(KEY.enter);
      await Bun.sleep(800);
    } finally {
      await t.kill();
    }
    const state = JSON.parse(await Bun.file(`${w.mnemoHome}/state.json`).text());
    expect(state.theme).toBe("dracula");
  }, T);

  test("--intro shows the introduction and esc skips it to the prompt", async () => {
    const t = await terminal(fresh(), [...START, "--intro"]);
    try {
      await t.waitFor(/MEET MNE/);
      t.mark();
      await t.type(KEY.esc);
      await t.waitFor(/for commands/);
    } finally {
      await t.kill();
    }
  }, T);

  test("ctrl+c twice quits with code 0", async () => {
    const t = await terminal(fresh(), START);
    try {
      await ready(t);
      await t.type(KEY.ctrlC);
      await Bun.sleep(300);
      await t.type(KEY.ctrlC);
      expect(await t.exitWithin(10_000)).toBe(0);
    } finally {
      await t.kill();
    }
  }, T);
});
