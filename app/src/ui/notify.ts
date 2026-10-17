/**
 * A desktop notification when a long turn ends, or stops to ask for approval,
 * while the terminal is in the background.
 *
 * The terminal says when it gains and loses focus once asked (`ESC[?1004h`;
 * it then sends `ESC[I` and `ESC[O`, which Ink drops). The notification is OSC 9,
 * which iTerm2, WezTerm, kitty, Ghostty and Windows Terminal show as a system
 * notification, followed by a bell, which nearly every other terminal turns
 * into a badge or a flashing tab. A terminal that never reports focus is taken
 * to be in front, so it is never interrupted. MNEMO_NOTIFY=0 turns it off.
 */
export const FOCUS_ON = "\x1b[?1004h";
export const FOCUS_OFF = "\x1b[?1004l";
/** Turns shorter than this end quietly: you were probably still watching. */
export const NOTIFY_AFTER_MS = 20_000;

/** The last focus report in a chunk of input: true in, false out, undefined none. */
export function parseFocus(chunk: string): boolean | undefined {
  const i = chunk.lastIndexOf("\x1b[I");
  const o = chunk.lastIndexOf("\x1b[O");
  if (i < 0 && o < 0) return undefined;
  return i > o;
}

export function notification(text: string): string {
  // OSC payloads end at BEL or ESC; keep the text to one printable line.
  const clean = text.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 200);
  return `\x1b]9;${clean}\x07\x07`;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

interface Watched {
  transcript: { subscribe(l: () => void): () => void; snapshot(): { working: { since: number } | null } };
  dialogs: { subscribe(l: () => void): () => void; current(): unknown };
}

export class Notifier {
  focused = true;
  constructor(
    private readonly write: (s: string) => void,
    private readonly now: () => number = Date.now,
    /** How long a turn must run to notify (the settings can change it while Mnemo runs). */
    private readonly after: () => number = () => NOTIFY_AFTER_MS,
  ) {}

  input(chunk: string): void {
    const f = parseFocus(chunk);
    if (f !== undefined) this.focused = f;
  }

  /** Follow one agent; returns the unsubscribe. */
  watch(name: string, c: Watched): () => void {
    let since: number | undefined;
    let asking = false;
    const offTranscript = c.transcript.subscribe(() => {
      const w = c.transcript.snapshot().working;
      if (w) {
        since ??= w.since;
        return;
      }
      if (since === undefined) return;
      const took = this.now() - since;
      since = undefined;
      if (!this.focused && took >= this.after()) this.write(notification(`mnemo · ${name}: done in ${duration(took)}`));
    });
    const offDialogs = c.dialogs.subscribe(() => {
      const open = c.dialogs.current() != null;
      if (open && !asking && !this.focused) this.write(notification(`mnemo · ${name}: waiting for your answer`));
      asking = open;
    });
    return () => {
      offTranscript();
      offDialogs();
    };
  }
}
