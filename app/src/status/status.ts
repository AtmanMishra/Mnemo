/**
 * The status line, as data rather than a sentence built in a render function.
 *
 * Every fact the interface wants to show — what it is running on, which provider
 * and model, whether memory and the kernel are up — is a *segment*, and a
 * segment is a named value. That is what makes the line configurable without
 * touching a renderer, and it is why the frame and the status line can show the
 * same facts without one of them drifting.
 *
 * Two rules, both from what the earlier interface got wrong:
 *
 *  1. **A missing fact says what to do, or says nothing.** A machine with no
 *     provider shows `no provider — /login`, not a blank space where a provider
 *     would be. Silence reads as "this is fine".
 *  2. **Nothing is padded to fill.** A line that has to be read is not improved
 *     by stretching it to the width.
 */
export interface StatusFacts {
  runtime: string;
  provider?: string;
  model?: string;
  memory: boolean;
  kernel: boolean;
  home?: string;
}

export type SegmentId = "runtime" | "provider" | "model" | "memory" | "kernel" | "home";

export interface Segment {
  id: SegmentId;
  /** What to draw. Empty means "this segment has nothing to say right now". */
  text: string;
  /** True when the segment is reporting a problem rather than a state. */
  alarm?: boolean;
}

export interface StatusPreset {
  id: string;
  left: readonly SegmentId[];
  right: readonly SegmentId[];
}

/** The presets, as data — the shape oh-my-pi uses, at our size. */
export const PRESETS: Record<string, StatusPreset> = {
  default: { id: "default", left: ["provider", "model"], right: ["memory", "kernel"] },
  minimal: { id: "minimal", left: ["provider"], right: [] },
  full: { id: "full", left: ["runtime", "provider", "model"], right: ["memory", "kernel", "home"] },
};

/** One segment's text, or empty when there is nothing honest to say. */
export function segmentText(id: SegmentId, facts: StatusFacts): Segment {
  switch (id) {
    case "runtime":
      return { id, text: facts.runtime };
    case "provider":
      return facts.provider
        ? { id, text: facts.provider }
        : { id, text: "no provider — /login", alarm: true };
    case "model":
      // Not an alarm: a provider with no chosen model still runs, it just asks
      // which model every time. Nagging about it in red would be dishonest.
      return { id, text: facts.model ?? "" };
    case "memory":
      return facts.memory ? { id, text: "memory" } : { id, text: "memory off" };
    case "kernel":
      return facts.kernel ? { id, text: "kernel" } : { id, text: "kernel off" };
    case "home":
      return facts.home ? { id, text: facts.home } : { id, text: "" };
  }
}

/** Every segment of a preset, in order, with the empty ones dropped. */
export function segmentsFor(facts: StatusFacts, preset: StatusPreset | string = "default"): Segment[] {
  const chosen = typeof preset === "string" ? PRESETS[preset] ?? PRESETS.default! : preset;
  return [...chosen.left, ...chosen.right]
    .map((id) => segmentText(id, facts))
    .filter((segment) => segment.text.length > 0);
}

const SEPARATOR = "  ·  ";

/** The line as it appears, fitted to the width it was given. */
export function renderStatusLine(
  facts: StatusFacts,
  options: { width: number; preset?: StatusPreset | string; prefix?: string },
): string {
  const text = segmentsFor(facts, options.preset).map((segment) => segment.text).join(SEPARATOR);
  const line = `${options.prefix ?? ""}${text}`;
  const width = Math.max(0, options.width);
  if (line.length <= width) return line;
  return `${line.slice(0, Math.max(0, width - 1))}…`;
}
