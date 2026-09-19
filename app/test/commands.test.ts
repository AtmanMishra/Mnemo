/**
 * Commands are not messages — asserted on the loop the interface could not
 * escape from, and on the ways a command can be wrong without pretending.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/session/session.ts";
import { createInterface, type TurnRunner } from "../src/session/host.ts";
import { runCommand, helpLines, PROVIDERS } from "../src/commands/commands.ts";

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

test("/login with a provider says exactly what is missing rather than pretending", () => {
  const { ctx: c } = ctx();
  const text = runCommand("/login openrouter", c).lines.join("\n");
  assert.match(text, /OpenRouter/);
  assert.match(text, /lands next|auth\.json/, "it says what will happen or what to do now");

  const unknown = runCommand("/login wat", c).lines.join("\n");
  assert.match(unknown, /unknown provider: wat/);
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
