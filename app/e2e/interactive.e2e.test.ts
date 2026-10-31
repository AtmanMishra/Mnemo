// The interactive interface in a real terminal: what only a person at a keyboard
// would otherwise find. Linux and macOS (Windows has no pty to drive).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { startMockLLM, type MockLLM } from "./mock-llm.ts";
import { binary, memsrv, world, type World } from "./harness.ts";
import { hasPty, KEY, submit, terminal, type Terminal } from "./pty.ts";

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
  test.each(["workspace", "inline"])("a %s terminal remains interactive under CI", async (layout) => {
    // Ink defaults to non-interactive under CI even with a PTY. Mnemo's TTY
    // decision must reach the renderer, or the prompt stays blank forever.
    const args = layout === "inline" ? [...START, "--inline"] : START;
    const t = await terminal(fresh(), args, { env: { CI: "true", GITHUB_ACTIONS: "true" } });
    try {
      await ready(t);
      await submit(t, "ping");
      await t.waitFor(/pong from the mock/);
    } finally {
      await t.kill();
    }
  }, T);

  test("a prompt typed in the workspace gets an answer", async () => {
    const t = await terminal(fresh(), START);
    try {
      await ready(t);
      await submit(t, "ping");
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
      await submit(t, "/login anthropic");
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
      await t.waitFor(/Open this link to sign in|Opening your browser|Login failed/);
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
      await submit(t, "/login anthropic");
      await t.waitFor(/how do you want to log in/);
      await Bun.sleep(600);
      await t.type(KEY.down);
      await Bun.sleep(300);
      // The menu itself says "API key": wait for the prompt that takes the key, or it is typed into nothing.
      t.mark();
      await t.type(KEY.enter);
      await t.waitFor(/input is hidden/);
      t.mark();
      await t.type("sk-ant-e2e-test-key");
      await t.waitFor(new RegExp("•".repeat("sk-ant-e2e-test-key".length)));
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
        await submit(t, `/login ${id}`);
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
      await submit(t, "/theme dracula");
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
      // One esc, as soon as the intro shows: the terminal is raw before the first frame, so the key
      // is not echoed as ^[ and lost while Ink is still turning raw mode on.
      await t.type(KEY.esc);
      await t.waitFor(/for commands/);
      expect(t.raw()).not.toContain("^[");
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

  test("esc with a message queued stops the run and puts the message back, without crashing the screen", async () => {
    // Keep the turn open until cleanup, however long this runner needs to type.
    const reply = Promise.withResolvers<{ text: string }>();
    const slow = startMockLLM(() => reply.promise);
    const t = await terminal(fresh({ llm: slow.url }), [...START, "--yolo"]);
    try {
      await ready(t);
      await submit(t, "wait a bit");
      await t.waitFor(/esc to interrupt/);
      await submit(t, "and then this");
      await t.waitFor(/queued:\s+and then this/);
      t.mark();
      await t.type(KEY.esc);
      await t.waitFor(/aborted|Interrupted/);
      // Search only post-Escape output, and require the draft's prompt prefix:
      // the queued row and earlier frames also contain the same words.
      await t.waitFor(/❯\s+and then this/);
      expect(t.text()).not.toMatch(/TypeError|ERROR|since/);
      expect(await t.exitWithin(200)).toBeUndefined();
    } finally {
      reply.resolve({ text: "done waiting" });
      await t.kill();
      slow.stop();
    }
  }, T);

  test("a subscription login shows its sign-in link, and esc cancels the wait", async () => {
    const t = await terminal(fresh(), START, { env: { BROWSER: "none" } });
    try {
      await ready(t);
      await submit(t, "/login anthropic");
      await t.waitFor(/how do you want to log in/);
      await Bun.sleep(600);
      t.mark();
      await t.type(KEY.enter); // Subscription
      await t.waitFor(/login method|Open this link to sign in|Login failed/);
      if (/login method/.test(t.text())) {
        await Bun.sleep(600);
        t.mark();
        await t.type(KEY.enter);
      }
      await t.waitFor(/Open this link to sign in/);
      // The visible label can reach the stream in pieces (Ink redraws what changed), so read
      // the link itself: the hyperlink's target and the copy put on the clipboard are whole.
      const raw = t.raw();
      const targets = [...raw.matchAll(/\x1b\]8;;(https:\/\/[^\x07\x1b]+)/g)].map((m) => m[1]!);
      const copied = [...raw.matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]+)/g)].map((m) => Buffer.from(m[1]!, "base64").toString());
      expect([...targets, ...copied].filter((u) => /^https:\/\/\S*(claude|anthropic)/.test(u))).not.toHaveLength(0);
      await Bun.sleep(400);
      t.mark();
      await t.type(KEY.esc);
      await Bun.sleep(300);
      await t.type(KEY.esc);
      await t.waitFor(/Login cancelled/);
    } finally {
      await t.kill();
    }
  }, T);

  // Windows only, outside tests: MNEMO_SELF_INSTALL_TEST lets the question come up here.
  describe.if(!!memsrv())("a downloaded copy", () => {
    /** mnemo and memsrv unzipped into a downloads folder, as a release archive leaves them. */
    function downloaded(w: World) {
      const dl = path.join(w.home, "Downloads", "mnemo");
      fs.mkdirSync(dl, { recursive: true });
      fs.copyFileSync(binary(), path.join(dl, "mnemo"));
      fs.chmodSync(path.join(dl, "mnemo"), 0o755);
      fs.copyFileSync(memsrv()!, path.join(dl, "memsrv"));
      return { dl, exe: path.join(dl, "mnemo") };
    }
    const env = { MNEMO_SELF_INSTALL_TEST: "1" };

    test("asks to install itself; no starts Mnemo, and is not asked again", async () => {
      const w = fresh();
      const d = downloaded(w);
      const bin = path.join(w.mnemoHome, "bin");
      let t = await terminal(w, START, { exe: d.exe, env });
      try {
        await t.waitFor(new RegExp(`Install Mnemo to ${bin} and add it to your PATH\\? \\[Y/n\\]`));
        await t.type("n");
        await t.type(KEY.enter);
        await ready(t);
      } finally {
        await t.kill();
      }
      expect(fs.existsSync(bin)).toBe(false);
      t = await terminal(w, START, { exe: d.exe, env });
      try {
        await ready(t);
        expect(t.text()).not.toContain("Install Mnemo to");
      } finally {
        await t.kill();
      }
    }, T);

    test("yes installs it, says what to do next, and exits", async () => {
      const w = fresh();
      const d = downloaded(w);
      const bin = path.join(w.mnemoHome, "bin");
      const t = await terminal(w, START, { exe: d.exe, env });
      try {
        await t.waitFor(/add it to your PATH\? \[Y\/n\]/);
        await t.type(KEY.enter);
        await t.waitFor(/Mnemo is installed/);
        expect(await t.exitWithin(10_000)).toBe(0);
      } finally {
        await t.kill();
      }
      expect(fs.readdirSync(bin).sort()).toEqual(["memsrv", "mnemo"]);
      expect(t.text()).toContain(`copied mnemo and memsrv to ${bin}`);
    }, T);
  });
});

