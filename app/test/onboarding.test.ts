import { test, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { loopDiagram, Onboarding, type OnboardingChoice } from "../src/ui/components/Onboarding.tsx";
import { MotionContext } from "../src/ui/components/motion.ts";

const tick = () => new Promise((r) => setTimeout(r, 15));
function mount(hasModel: boolean) {
  const choices: OnboardingChoice[] = [];
  const r = render(
    React.createElement(MotionContext.Provider, { value: false }, React.createElement(Onboarding, { hasModel, columns: 100, rows: 30, onDone: (c) => choices.push(c) })),
  );
  return { ...r, choices };
}

test("five pages forward and back, then a choice of how to get a model", async () => {
  const r = mount(false);
  expect(r.lastFrame()).toContain("MEET MNE");
  for (const title of ["HOW IT LEARNS", "THE WORKSPACE", "YOUR OTHER AGENTS", "A MODEL"]) {
    r.stdin.write("\r");
    await tick();
    expect(r.lastFrame()).toContain(title);
  }
  r.stdin.write("\x1b[D"); // ←
  await tick();
  expect(r.lastFrame()).toContain("YOUR OTHER AGENTS");
  r.stdin.write("\x1b[C"); // →
  await tick();
  r.stdin.write("\x1b[B"); // ↓ to the demo
  await tick();
  r.stdin.write("\r");
  await tick();
  expect(r.choices).toEqual(["demo"]);
  r.unmount();
});

test("esc skips; with a model ready the last page just starts", async () => {
  const skip = mount(false);
  skip.stdin.write("\x1b");
  // A lone ESC is held briefly in case an escape sequence follows.
  await new Promise((r) => setTimeout(r, 120));
  expect(skip.choices).toEqual(["later"]);
  skip.unmount();
  const ready = mount(true);
  for (let i = 0; i < 4; i++) {
    ready.stdin.write("\r");
    await tick();
  }
  expect(ready.lastFrame()).toContain("A model is ready");
  ready.stdin.write("\r");
  await tick();
  expect(ready.choices).toEqual(["later"]);
  ready.unmount();
});

test("the signal travels the wire, one position per tick", () => {
  const at = (t: number) => loopDiagram(t)[0]!.indexOf("●");
  expect(at(0)).toBeGreaterThan(0);
  expect(at(1)).toBe(at(0) + 1);
  expect(loopDiagram(0)[0]!.length).toBe(loopDiagram(5)[0]!.length);
});
