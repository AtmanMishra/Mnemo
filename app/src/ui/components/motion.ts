import { createContext } from "react";

/** Whether anything may animate. Off in tests, in `--dump`, and when stdout is not a TTY. */
export const MotionContext = createContext(true);
