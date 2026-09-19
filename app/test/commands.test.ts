/**
 * Commands are not messages — asserted on the loop the interface could not
 * escape from, and on the ways a command can be wrong without pretending.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/session/session.ts";
import { createInterface, type TurnRunner } from "../src/session/host.ts";
import { runCommand, helpLines, PROVIDERS } from "../src/commands/commands.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readAuth } from "../src/commands/store.ts";

function ctx(overrides: Partial<Parameters<typeof runCommand>[1]> = {}) {
  let exited = false;
  return {
    ctx: {
      session: new Session({ keepLive: 0 }),
      home: "C:/home/.mnemo",
      exit: () => (exited = true),
      ...overrides,
    },
    exited: () => exited,
  };
}

test("/help lists the commands, each with what it does", () => {
  const lines = helpLines().join("\n");
  for (const name of ["/help", "/login", "/model", "/quit"]) {
    assert.match(lines, new RegExp(name.replace("/", "\\/")), `${name} is listed`);
  }
});

test("/login with no argument lists providers and names the next step", () => {
  const { ctx: c } = ctx();
  const result = runCommand("/login", c);
  const text = result.lines.join("\n");
  assert.match(text, /which provider/);
  for (const provider of PROVIDERS) assert.match(text, new RegExp(provider.id), `${provider.id} is offered`);
});

test("/login with a provider asks for the key, and says where it will go", () => {
  const { ctx: c } = ctx();
  const result = runCommand("/login openrouter", c);
  const text = result.lines.join("\n");
  assert.match(text, /OpenRouter/);
  assert.match(text, /not echoed/, "the reader is told what will happen to the key");
  assert.equal(result.beginSecret, "openrouter", "and the interface is asked to collect it");

  const unknown = runCommand("/login wat", c).lines.join("\n");
  assert.match(unknown, /unknown provider: wat/);
});

test("the whole login: paste a key, it is stored, and the transcript never holds it", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-login-"));
  try {
    const key = "sk-or-a-secret-that-must-not-be-logged";
    const session = new Session({ keepLive: 0 });
    let scrollback: string[] = [];
    const iface = createInterface({ session, redraw: () => {}, facts: { home } });
    const screen = () => {
      const { history, viewport } = session.render(80);
      scrollback = [...scrollback, ...history];
      return [...scrollback, ...viewport].join("\n");
    };

    iface.composer.push("/login openrouter\r"); // the command
    assert.equal(iface.composer.secret?.provider, "openrouter", "the key prompt is now on");

    iface.composer.push(key); // pasted, as keys usually are
    assert.equal(iface.composer.secret?.length, key.length, "it is being accepted");
    assert.doesNotMatch(screen(), new RegExp(key), "and it is not on screen while it is typed");

    iface.composer.push("\r"); // enter
    assert.equal(iface.composer.secret, undefined, "the prompt closed");

    assert.equal(readAuth(home).providers.openrouter?.key, key, "it went where it belongs");
    const shown = screen();
    assert.match(shown, /logged in to openrouter/, "the reader is told it worked");
    assert.doesNotMatch(shown, new RegExp(key), "and the key is nowhere in the transcript");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("ctrl+c cancels a key prompt and stores nothing", () => {
  // The regression the real run found: everything in ONE chunk, the way a pipe
  // or a paste delivers it. The earlier version of this suite pushed the command
  // and the key as separate chunks, which is how a human types and how a bug
  // like this hides.
  const oneChunkHome = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-login-"));
  try {
    const key = "sk-or-pasted-in-one-go-1234567";
    const session = new Session({ keepLive: 0 });
    let scrollback: string[] = [];
    const iface = createInterface({ session, redraw: () => {}, facts: { home: oneChunkHome } });
    const screen = () => {
      const { history, viewport } = session.render(80);
      scrollback = [...scrollback, ...history];
      return [...scrollback, ...viewport].join("\n");
    };

    iface.composer.push(`/login openrouter\r${key}\r`);

    assert.equal(readAuth(oneChunkHome).providers.openrouter?.key, key, "the key went to the store");
    assert.doesNotMatch(screen(), new RegExp(key), "and never to the transcript");
    assert.doesNotMatch(screen(), /▶ sk-o/, "it did not become a message");
  } finally {
    fs.rmSync(oneChunkHome, { recursive: true, force: true });
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-login-"));
  try {
    const session = new Session({ keepLive: 0 });
    const iface = createInterface({ session, redraw: () => {}, facts: { home } });
    iface.composer.push("/login openai\r");
    iface.composer.push("sk-openai-half-typed");
    iface.composer.push("\x03");
    assert.equal(iface.composer.secret, undefined, "the prompt is closed");
    assert.deepEqual(readAuth(home).providers, {}, "and nothing was written");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a key that is obviously wrong is described, not stored", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-login-"));
  try {
    const session = new Session({ keepLive: 0 });
    let scrollback: string[] = [];
    const iface = createInterface({ session, redraw: () => {}, facts: { home } });
    const screen = () => {
      const { history, viewport } = session.render(80);
      scrollback = [...scrollback, ...history];
      return [...scrollback, ...viewport].join("\n");
    };

    iface.composer.push("/login openai\r");
    iface.composer.push("abc\r");
    assert.match(screen(), /too short/, "it says what is wrong with it");
    assert.deepEqual(readAuth(home).providers, {}, "and stores nothing");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("/model without a provider points at /login, not at itself", () => {
  const { ctx: c } = ctx();
  assert.match(runCommand("/model", c).lines.join("\n"), /no provider yet — `\/login` first/);
});

test("a typo costs nothing: an unknown command never becomes a turn", () => {
  const { ctx: c } = ctx();
  const text = runCommand("/modle", c).lines.join("\n");
  assert.match(text, /no such command: \/modle/);
  assert.match(text, /\/help/, "and where to look");
});

test("/quit leaves, and says so", () => {
  const { ctx: c, exited } = ctx();
  const result = runCommand("/quit", c);
  assert.equal(result.exited, true);
  assert.equal(exited(), true);
});

test("a command reaches the screen through the host, and the agent is never called", () => {
  let ran = 0;
  const agent: TurnRunner = {
    run: () => {
      ran += 1;
    },
    interrupt: () => {},
  };
  const session = new Session({ keepLive: 0 });
  let scrollback: string[] = [];
  const iface = createInterface({
    session,
    agent,
    redraw: () => {},
    facts: { home: "C:/home/.mnemo" },
  });
  const screen = () => {
    const { history, viewport } = session.render(60);
    scrollback = [...scrollback, ...history];
    return [...scrollback, ...viewport].join("\n");
  };

  iface.host.submit("/help");
  assert.equal(ran, 0, "a command is not a turn — no model call, no cost");
  const shown = screen();
  assert.match(shown, /▶ \/help/, "the command is echoed so the transcript reads in order");
  assert.match(shown, /commands:/, "and the answer is under it");
  assert.match(shown, /\/login/, "including the way to get started");

  iface.host.submit("hello");
  assert.equal(ran, 1, "a message is still a message");
});
