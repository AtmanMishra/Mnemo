/**
 * What a launch shows, in order: the boot sequence, the onboarding on a
 * first run, then the interface — the shell of agents (full screen), or the inline
 * transcript (`--inline`, and anything that is not a terminal).
 */
import React, { useState } from "react";
import { useWindowSize } from "ink";
import type { Controller } from "../runtime/controller.ts";
import { App } from "./App.tsx";
import { Boot, type BootInfo } from "./components/Boot.tsx";
import { MotionContext } from "./components/motion.ts";
import { Onboarding, type OnboardingChoice } from "./components/Onboarding.tsx";
import type { Fleet } from "../runtime/fleet.ts";
import { Shell } from "./Shell.tsx";

export interface RootProps {
  /** The first agent: the inline layout and the onboarding use it. */
  controller: Controller;
  fleet: Fleet;
  version: string;
  home: string;
  motion: boolean;
  layout: "workspace" | "inline";
  /** Play the launch sequence (a terminal, not a dump). */
  boot: boolean;
  /** Show the onboarding (first run, or --intro). */
  onboard: boolean;
  stats?: BootInfo["stats"];
  clearTerminal: () => void;
  onOnboarded: (choice: OnboardingChoice) => void;
}

type Phase = "boot" | "onboarding" | "main";

export function Root(p: RootProps): React.ReactElement {
  const { columns, rows } = useWindowSize();
  const [phase, setPhase] = useState<Phase>(p.boot ? "boot" : p.onboard ? "onboarding" : "main");
  if (phase === "boot")
    return (
      <MotionContext.Provider value={p.motion}>
        <Boot info={{ version: p.version, stats: p.stats, columns, rows }} onDone={() => setPhase(p.onboard ? "onboarding" : "main")} />
      </MotionContext.Provider>
    );
  if (phase === "onboarding")
    return (
      <MotionContext.Provider value={p.motion}>
        <Onboarding
          hasModel={p.controller.hasModel}
          columns={columns}
          rows={rows}
          onDone={(choice) => {
            p.onOnboarded(choice);
            setPhase("main");
          }}
        />
      </MotionContext.Provider>
    );
  return p.layout === "workspace" ? (
    <Shell fleet={p.fleet} motion={p.motion} />
  ) : (
    <App controller={p.controller} version={p.version} home={p.home} motion={p.motion} clearTerminal={p.clearTerminal} />
  );
}
