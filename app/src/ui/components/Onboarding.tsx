/**
 * First run: five short pages, pixels and ASCII, then the workspace.
 *
 *   1 meet Mne        what Mnemo is, by the one who never forgets
 *   2 how it learns   session → reflect → memory → next session, a signal
 *                     travelling the wire
 *   3 the workspace   a miniature of the screen you are about to get
 *   4 other agents    the same memory in Claude Code, Codex, Cursor
 *   5 a model         log in now, try the demo, or later
 *
 * ← → (or enter) move, esc skips. Each page is a pure function of its step
 * and an animation tick, so it renders the same in a test.
 */
import React, { useContext, useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { palette } from "../theme.ts";
import { mne } from "../pixel.ts";
import { PixelArt } from "./PixelArt.tsx";
import { MotionContext } from "./motion.ts";

export type OnboardingChoice = "login" | "demo" | "later";

const STEPS = ["meet", "learns", "workspace", "agents", "model"] as const;

function Progress({ step }: { step: number }): React.ReactElement {
  return (
    <Text>
      {STEPS.map((_, i) => (
        <Text key={i} color={i === step ? palette.magenta : i < step ? palette.cyan : palette.faint}>
          {i === step ? "■ " : i < step ? "■ " : "□ "}
        </Text>
      ))}
      <Text color={palette.dim}>
        {"  "}
        {step + 1}/{STEPS.length}
      </Text>
    </Text>
  );
}

function Title({ children }: { children: string }): React.ReactElement {
  return (
    <Text>
      <Text color={palette.magenta}>▐</Text>
      <Text color={palette.ground} backgroundColor={palette.magenta} bold>
        {` ${children.toUpperCase()} `}
      </Text>
      <Text color={palette.magenta}>▌</Text>
    </Text>
  );
}

/** A key cap: [ctrl+b]. */
export function Key({ k }: { k: string }): React.ReactElement {
  return (
    <Text>
      <Text color={palette.faint}>[</Text>
      <Text color={palette.cyan}>{k}</Text>
      <Text color={palette.faint}>]</Text>
    </Text>
  );
}

function Meet({ tick }: { tick: number }): React.ReactElement {
  const blinking = tick % 40 >= 37;
  return (
    <Box flexDirection="row" gap={3}>
      <PixelArt grid={blinking ? mne.blink : mne.idle} />
      <Box flexDirection="column" justifyContent="center" width={44}>
        <Title>meet mne</Title>
        <Text> </Text>
        <Text color={palette.text}>Mnemo is a coding agent that remembers.</Text>
        <Text> </Text>
        <Text color={palette.dim}>Each session teaches it your project: the conventions, the commands that work, the fixes for what broke, and what was left open.</Text>
        <Text> </Text>
        <Text color={palette.dim}>
          Mne keeps it. <Text color={palette.amber}>Elephants never forget.</Text>
        </Text>
      </Box>
    </Box>
  );
}

/** The learning loop as a wire a signal travels. */
export function loopDiagram(tick: number): string[] {
  const top = " ▣ session ───── ◇ reflect ───── ◈ memory ───── ▣ next session";
  const runAt = [10, 11, 12, 13, 14, 26, 27, 28, 29, 30, 41, 42, 43, 44, 45];
  const pos = runAt[tick % runAt.length]!;
  const line = [...top].map((ch, i) => (i === pos ? "●" : ch)).join("");
  return [line, "                                    │", "                ◆ facts ──── ◆ fixes ──── ◆ skills ──── ◆ sessions"];
}

function Learns({ tick }: { tick: number }): React.ReactElement {
  const [a, b, c] = loopDiagram(tick);
  return (
    <Box flexDirection="column" width={72}>
      <Title>how it learns</Title>
      <Text> </Text>
      <Text color={palette.cyan}>{a}</Text>
      <Text color={palette.faint}>{b}</Text>
      <Text color={palette.amber}>{c}</Text>
      <Text> </Text>
      <Text color={palette.dim}>After each run, one small model call reads what happened and keeps what will still be true next week: what you said, what a tool showed, which fix worked.</Text>
      <Text color={palette.dim}>Next time, it comes back before the first token — and a command that failed before is stopped once, with its fix.</Text>
    </Box>
  );
}

function Workspace(): React.ReactElement {
  const row = (l: string, r: string, lc: string = palette.dim, rc: string = palette.dim) => (
    <Text>
      <Text color={palette.faint}>│</Text>
      <Text color={lc}>{l.padEnd(16)}</Text>
      <Text color={palette.faint}>│</Text>
      <Text color={rc}>{r.slice(0, 40).padEnd(40)}</Text>
      <Text color={palette.faint}>│</Text>
    </Text>
  );
  return (
    <Box flexDirection="column" width={74}>
      <Title>the workspace</Title>
      <Text> </Text>
      <Text color={palette.faint}>┌────────────────┬────────────────────────────────────────┐</Text>
      {row(" ▐ FILES ▌", " ❯ fix the flaky login test", palette.magenta, palette.text)}
      {row("  ▾ src", " ◆ The session cookie expires before…", palette.cyan, palette.text)}
      {row("    auth.ts", " ▣ bash  pnpm vitest auth   ✓")}
      {row("    login.ts", " ◈ recalled 1 pitfall · fix: refresh first", palette.dim, palette.amber)}
      {row("  ▸ test", "")}
      <Text color={palette.faint}>├────────────────┴────────────────────────────────────────┤</Text>
      <Text>
        <Text color={palette.faint}>│ </Text>
        <Text color={palette.magenta}>❯ </Text>
        <Text color={palette.dim}>{"ask, or / for commands, @ for files".padEnd(54)}</Text>
        <Text color={palette.faint}>│</Text>
      </Text>
      <Text color={palette.faint}>└─────────────────────────────────────────────────────────┘</Text>
      <Text> </Text>
      <Text color={palette.dim}>
        <Key k="ctrl+b" /> sidebar  <Key k="tab" /> focus  <Key k="1-5" /> panes  <Key k="pgup" /> scroll
      </Text>
    </Box>
  );
}

function Agents(): React.ReactElement {
  return (
    <Box flexDirection="column" width={74}>
      <Title>your other agents</Title>
      <Text> </Text>
      <Text color={palette.text}>The memory is not only Mnemo&apos;s. Attach it to the agents you already use:</Text>
      <Text> </Text>
      <Text>
        <Text color={palette.cyan}> ◆ Claude Code </Text>
        <Text color={palette.dim}>mnemo memory setup claude-code</Text>
      </Text>
      <Text>
        <Text color={palette.cyan}> ◆ Codex · Cursor · opencode </Text>
        <Text color={palette.dim}>mnemo memory setup codex</Text>
      </Text>
      <Text>
        <Text color={palette.cyan}> ◆ past sessions </Text>
        <Text color={palette.dim}>mnemo memory ingest</Text>
      </Text>
      <Text> </Text>
      <Text color={palette.dim}>What a frontier model works out there, a cheaper one recalls here.</Text>
    </Box>
  );
}

const CHOICES: { key: OnboardingChoice; label: string; hint: string }[] = [
  { key: "login", label: "Log in to a provider", hint: "Anthropic, OpenAI, OpenCode, OpenRouter …" },
  { key: "demo", label: "Watch a demo", hint: "a scripted session, no key needed" },
  { key: "later", label: "Later", hint: "/login whenever you are ready" },
];

function Model({ selected, hasModel }: { selected: number; hasModel: boolean }): React.ReactElement {
  return (
    <Box flexDirection="column" width={74}>
      <Title>a model</Title>
      <Text> </Text>
      {hasModel ? (
        <Text color={palette.green}>✓ A model is ready. Press enter to start.</Text>
      ) : (
        <>
          <Text color={palette.text}>Mnemo needs a model to think with. Any provider pi supports works; a cheap one does well once memory has learned your project.</Text>
          <Text> </Text>
          {CHOICES.map((c, i) => (
            <Text key={c.key}>
              <Text color={i === selected ? palette.magenta : palette.faint}>{i === selected ? " ▶ " : "   "}</Text>
              <Text color={i === selected ? palette.text : palette.dim} bold={i === selected}>
                {c.label.padEnd(24)}
              </Text>
              <Text color={palette.faint}>{c.hint}</Text>
            </Text>
          ))}
        </>
      )}
    </Box>
  );
}

export function Onboarding({
  hasModel,
  onDone,
  columns,
  rows,
  startAt = 0,
  active = true,
}: {
  hasModel: boolean;
  onDone: (choice: OnboardingChoice) => void;
  columns: number;
  rows: number;
  startAt?: number;
  /** Listen for keys (off for a frame rendered without a keyboard). */
  active?: boolean;
}): React.ReactElement {
  const motion = useContext(MotionContext);
  const [step, setStep] = useState(startAt);
  const [selected, setSelected] = useState(0);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!motion) return;
    const id = setInterval(() => setTick((t) => t + 1), 120);
    return () => clearInterval(id);
  }, [motion]);
  const last = STEPS.length - 1;
  useInput((input, key) => {
    if (key.escape) return onDone(hasModel ? "later" : "later");
    if (step === last && !hasModel) {
      if (key.upArrow) return setSelected((s) => (s + CHOICES.length - 1) % CHOICES.length);
      if (key.downArrow) return setSelected((s) => (s + 1) % CHOICES.length);
    }
    if (key.leftArrow) return setStep((s) => Math.max(0, s - 1));
    if (key.rightArrow || key.return || input === " ") {
      if (step < last) return setStep((s) => s + 1);
      if (key.return || input === " ") return onDone(hasModel ? "later" : CHOICES[selected]!.key);
    }
  }, { isActive: active });
  const page =
    STEPS[step] === "meet" ? (
      <Meet tick={tick} />
    ) : STEPS[step] === "learns" ? (
      <Learns tick={tick} />
    ) : STEPS[step] === "workspace" ? (
      <Workspace />
    ) : STEPS[step] === "agents" ? (
      <Agents />
    ) : (
      <Model selected={selected} hasModel={hasModel} />
    );
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" width={columns} height={Math.max(12, rows - 1)}>
      <Box flexDirection="column" minHeight={14}>
        {page}
      </Box>
      <Box marginTop={1} flexDirection="column" alignItems="center">
        <Progress step={step} />
        <Text color={palette.faint}>
          ← → move · {step === last ? (hasModel ? "enter start" : "↑ ↓ choose · enter go") : "enter next"} · esc skip
        </Text>
      </Box>
    </Box>
  );
}
