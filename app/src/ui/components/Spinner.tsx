import React from "react";
import { Text, useAnimation } from "ink";
import { color, spinnerFrames } from "../theme.ts";
import { MotionContext } from "./motion.ts";

/** A braille spinner; a still dot when motion is off (tests, --no-motion, not a TTY). */
export function Spinner({ tint = color.accent }: { tint?: string }): React.ReactElement {
  const motion = React.useContext(MotionContext);
  const { frame } = useAnimation({ interval: 80, isActive: motion });
  return <Text color={tint}>{motion ? spinnerFrames[frame % spinnerFrames.length] : "•"}</Text>;
}
