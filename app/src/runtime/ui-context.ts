/**
 * pi's extension UI context, answered by the Ink interface.
 *
 * pi extensions talk to "the UI" through this one object. The question-shaped
 * calls (`select`, `confirm`, `input`, `editor`) go to the dialog queue; the
 * status-shaped ones (`notify`, `setStatus`, `setWorkingMessage`, `setTitle`)
 * go to the interface's state. The calls that hand over pi-tui components
 * (`custom`, component widgets, headers, footers, editors) cannot be honoured by
 * an Ink interface and are ignored, the same way pi's own RPC mode ignores them.
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Dialogs } from "./dialogs.ts";

export interface UiSink {
  notify(message: string, tone: "info" | "warn" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  setWorkingMessage(message: string | undefined): void;
  setWorkingVisible(visible: boolean): void;
  setTitle(title: string): void;
  getDraft(): string;
  setDraft(text: string): void;
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
}

/**
 * A theme that styles nothing. Extensions that colour their own output through
 * `ctx.ui.theme.fg(...)` get their text back unstyled instead of a crash: every
 * method returns its last string argument.
 */
const plainTheme = new Proxy(
  {},
  {
    get: () => (...args: unknown[]) => {
      for (let i = args.length - 1; i >= 0; i--) if (typeof args[i] === "string") return args[i];
      return "";
    },
  },
);

export function createUiContext(dialogs: Dialogs, sink: UiSink): ExtensionUIContext {
  const ctx = {
    select: (title: string, options: string[], opts?: { signal?: AbortSignal }) =>
      dialogs.select(
        title,
        options.map((o) => ({ value: o, label: o })),
        opts?.signal,
      ),
    confirm: (title: string, message: string, opts?: { signal?: AbortSignal }) => dialogs.confirm(title, message, opts?.signal),
    input: (title: string, placeholder?: string, opts?: { signal?: AbortSignal }) =>
      dialogs.text(title, { placeholder, signal: opts?.signal }),
    editor: (title: string, prefill?: string) => dialogs.text(title, { placeholder: prefill }),
    notify: (message: string, type?: "info" | "warning" | "error") =>
      sink.notify(message, type === "warning" ? "warn" : (type ?? "info")),
    onTerminalInput: () => () => {},
    setStatus: (key: string, text: string | undefined) => sink.setStatus(key, text),
    setWorkingMessage: (message?: string) => sink.setWorkingMessage(message),
    setWorkingVisible: (visible: boolean) => sink.setWorkingVisible(visible),
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: (key: string, content: unknown) => {
      if (content === undefined || Array.isArray(content)) sink.setStatus(`widget:${key}`, (content as string[] | undefined)?.join(" "));
    },
    setFooter: () => {},
    setHeader: () => {},
    setTitle: (title: string) => sink.setTitle(title),
    custom: async () => undefined,
    pasteToEditor: (text: string) => sink.setDraft(sink.getDraft() + text),
    setEditorText: (text: string) => sink.setDraft(text),
    getEditorText: () => sink.getDraft(),
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    get theme() {
      return plainTheme;
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Mnemo draws its own theme" }),
    getToolsExpanded: () => sink.getToolsExpanded(),
    setToolsExpanded: (expanded: boolean) => sink.setToolsExpanded(expanded),
  };
  return ctx as unknown as ExtensionUIContext;
}
