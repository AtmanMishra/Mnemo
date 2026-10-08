/**
 * The whole screen: finished blocks in the terminal's scrollback, the live turn,
 * the working line, a dialog when one is open, and the composer.
 */
import React, { useMemo, useSyncExternalStore } from "react";
import { Box, Static, useWindowSize } from "ink";
import type { Controller } from "../runtime/controller.ts";
import { BlockView } from "./components/Blocks.tsx";
import { Composer } from "./components/Composer.tsx";
import { DialogView } from "./components/Dialogs.tsx";
import { MotionContext } from "./components/motion.ts";
import { WorkingLine } from "./components/Working.tsx";
import type { WelcomeInfo } from "./components/Welcome.tsx";
import { listFiles } from "./files.ts";
import { displayCwd } from "./format.ts";

export interface AppProps {
  controller: Controller;
  version: string;
  home: string;
  motion: boolean;
  /** Clears the real terminal (scrollback included) before the transcript remounts. */
  clearTerminal: () => void;
}

export function App({ controller, version, home, motion, clearTerminal }: AppProps): React.ReactElement {
  const snap = useSyncExternalStore(controller.transcript.subscribe, controller.transcript.snapshot);
  const chrome = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const dialog = useSyncExternalStore(controller.dialogs.subscribe, controller.dialogs.current);
  const { columns } = useWindowSize();
  const cwd = controller.runtime.cwd;

  // Fixed at start: the welcome card is printed once, into scrollback.
  const welcome = useMemo<WelcomeInfo>(
    () => ({
      version,
      cwd: displayCwd(cwd, home, Math.max(20, columns - 16)),
      model: chrome.footer.model,
      needsLogin: !controller.hasModel,
      columns,
    }),
    [],
  );

  const files = useMemo(() => {
    let cache: string[] | undefined;
    return () => (cache ??= listFiles(cwd));
  }, [cwd]);

  const render = (b: (typeof snap.committed)[number]) => (
    <BlockView key={b.id} block={b} cwd={cwd} expanded={chrome.expanded} welcome={welcome} />
  );

  return (
    <MotionContext.Provider value={motion}>
      <Static key={snap.epoch} items={[...snap.committed]}>
        {render}
      </Static>
      <Box flexDirection="column" width={columns}>
        {snap.live.map(render)}
        {chrome.workingVisible ? <WorkingLine working={snap.working} message={dialog ? "Waiting for you…" : chrome.workingMessage} queue={snap.queue} /> : null}
        {dialog ? <DialogView dialog={dialog} /> : null}
        <Composer
          working={snap.working !== null}
          active={!dialog}
          commands={() => controller.commands()}
          files={files}
          footer={chrome.footer}
          statuses={chrome.statuses}
          draftRequest={chrome.draftRequest}
          onSubmit={(text, mode) => void controller.submit(text, mode)}
          onInterrupt={() => controller.interrupt()}
          onQuit={() => void controller.quit()}
          onDraft={(t) => controller.reportDraft(t)}
          onToggleExpanded={() => controller.toggleExpanded()}
          onClear={() => {
            clearTerminal();
            controller.transcript.clear();
          }}
          onCycleThinking={() => controller.cycleThinking()}
          onCycleMode={() => controller.cycleMode()}
        />
      </Box>
    </MotionContext.Provider>
  );
}
