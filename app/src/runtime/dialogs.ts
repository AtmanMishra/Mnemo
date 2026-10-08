/**
 * Questions the interface is waiting on the user to answer.
 *
 * Mnemo's own flows (`/model`, `/login`) and pi extensions (through the
 * extension UI context) ask through the same queue, so there is one dialog
 * component family and one place that decides which question is on screen:
 * the oldest. Every request resolves exactly once — answered or cancelled.
 */
export interface Choice {
  value: string;
  label: string;
  description?: string;
}

/** A tool call waiting for the user's yes or no. */
export interface ApprovalRequest {
  /** "Bash", "Edit", "Python"… */
  tool: string;
  /** The command, the path — what the call is about, on one line. */
  subject: string;
  /** Lines shown under it: the diff, the code, the content. */
  preview: { text: string; tone?: "add" | "remove" | "muted" }[];
  /** What "don't ask again" would cover, when that is offerable. */
  always?: string;
  /** Why it is being asked (the gate's reason). */
  reason?: string;
}

export type ApprovalAnswer = { kind: "yes" } | { kind: "always" } | { kind: "no"; feedback?: string };

export type Dialog =
  | { id: number; kind: "select"; title: string; choices: Choice[]; resolve: (value: string | undefined) => void }
  | { id: number; kind: "confirm"; title: string; message: string; resolve: (ok: boolean) => void }
  | { id: number; kind: "approval"; request: ApprovalRequest; resolve: (answer: ApprovalAnswer) => void }
  | {
      id: number;
      kind: "text";
      title: string;
      placeholder?: string;
      secret?: boolean;
      resolve: (value: string | undefined) => void;
    };

type Request =
  | Omit<Extract<Dialog, { kind: "approval" }>, "id" | "resolve">
  | Omit<Extract<Dialog, { kind: "select" }>, "id" | "resolve">
  | Omit<Extract<Dialog, { kind: "confirm" }>, "id" | "resolve">
  | Omit<Extract<Dialog, { kind: "text" }>, "id" | "resolve">;

export class Dialogs {
  private queue: Dialog[] = [];
  private seq = 0;
  private listeners = new Set<() => void>();

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /** The dialog on screen, or undefined. */
  current = (): Dialog | undefined => this.queue[0];

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private open<T>(req: Request, signal?: AbortSignal, cancelled?: T): Promise<T> {
    return new Promise<T>((resolve) => {
      const id = ++this.seq;
      let settled = false;
      const done = (value: T) => {
        if (settled) return;
        settled = true;
        this.queue = this.queue.filter((d) => d.id !== id);
        signal?.removeEventListener("abort", onAbort);
        this.emit();
        resolve(value);
      };
      const onAbort = () => done(cancelled as T);
      if (signal?.aborted) return resolve(cancelled as T);
      signal?.addEventListener("abort", onAbort);
      this.queue = [...this.queue, { ...req, id, resolve: done } as Dialog];
      this.emit();
    });
  }

  select(title: string, choices: Choice[], signal?: AbortSignal): Promise<string | undefined> {
    return this.open({ kind: "select", title, choices }, signal, undefined);
  }

  confirm(title: string, message: string, signal?: AbortSignal): Promise<boolean> {
    return this.open({ kind: "confirm", title, message }, signal, false);
  }

  text(title: string, options: { placeholder?: string; secret?: boolean; signal?: AbortSignal } = {}): Promise<string | undefined> {
    return this.open({ kind: "text", title, placeholder: options.placeholder, secret: options.secret }, options.signal, undefined);
  }

  approval(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalAnswer> {
    return this.open({ kind: "approval", request }, signal, { kind: "no" } as ApprovalAnswer);
  }

  /** Cancel everything (shutdown). */
  cancelAll(): void {
    for (const d of [...this.queue]) {
      if (d.kind === "confirm") d.resolve(false);
      else if (d.kind === "approval") d.resolve({ kind: "no" });
      else d.resolve(undefined);
    }
  }
}
