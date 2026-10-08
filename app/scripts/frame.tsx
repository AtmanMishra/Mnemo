#!/usr/bin/env bun
/**
 * One frame of a screen, printed once — for snapshots and design review.
 *
 *   FORCE_COLOR=3 bun scripts/frame.tsx boot 650 | bun scripts/snapshot.ts boot.png
 *   bun scripts/frame.tsx boot <ms> [--cols 100 --rows 28]
 */
import React from "react";
import { render } from "ink";
import { Boot } from "../src/ui/components/Boot.tsx";
import { Onboarding } from "../src/ui/components/Onboarding.tsx";
import { MotionContext } from "../src/ui/components/motion.ts";

const argv = process.argv.slice(2);
const opt = (n: string, d: number) => (argv.includes(n) ? Number(argv[argv.indexOf(n) + 1]) : d);
const columns = opt("--cols", 100);
const rows = opt("--rows", 28);
Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });

const [screen, arg] = argv;
let el: React.ReactElement;
if (screen === "boot")
  el = <Boot at={Number(arg ?? 1600)} onDone={() => {}} info={{ version: "0.1.0", columns, rows, stats: { memories: 412, skills: 9, sessions: 37 } }} />;
else if (screen === "onboarding")
  el = <Onboarding startAt={Number(arg ?? 0)} active={false} hasModel={false} onDone={() => {}} columns={columns} rows={rows} />;
else throw new Error(`unknown screen ${screen}`);

const { unmount } = render(<MotionContext.Provider value={false}>{el}</MotionContext.Provider>, { interactive: false });
unmount();
