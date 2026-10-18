import * as vscode from "vscode";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { composerDraft, forwardable, launchArgs, reference, relativeTo, rpcArgs } from "./core";
import { MnemoClient } from "./client";
import type { RpcEvent } from "./protocol";
import { initial, reduce, type State } from "./webview/reduce";
import { THEMES } from "./webview/themes";

/**
 * Mnemo's interface in the editor: a panel that drives `mnemo --rpc`. Every decision the
 * terminal asks of the user (a command, an edit, a login) arrives as a dialog event and
 * is answered by the user clicking in the panel; this file never answers one itself and
 * never starts Mnemo with an option that skips them.
 */

const VIEW = "mnemo.chat";
const THEME_VALUES: string[] = ["editor", ...Object.keys(THEMES)];

class Session implements vscode.Disposable {
  private client: MnemoClient | undefined;
  private state: State = initial();
  private problem: string | undefined;
  private running = false;
  private readonly views = new Set<vscode.Webview>();
  private readonly bar: vscode.StatusBarItem;
  private lastAsked = 0;
  private resume = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    this.bar.command = "mnemo.open";
    this.paint();
    this.bar.show();
  }

  private cfg<T>(name: string, fallback: T): T {
    return vscode.workspace.getConfiguration("mnemo").get<T>(name, fallback);
  }

  private folder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  /** Start Mnemo for the first folder, once. Returns whether it is running. */
  ensure(resume = false): boolean {
    if (this.client?.running) return true;
    const root = this.folder();
    if (!root) {
      this.fail("Open a folder first: Mnemo works in a project.");
      return false;
    }
    if (!vscode.workspace.isTrusted) {
      this.fail("Mnemo runs commands and edits files; trust this workspace first.");
      return false;
    }
    this.state = initial();
    this.problem = undefined;
    this.resume = resume;
    this.client = new MnemoClient({
      command: this.cfg("path", "mnemo"),
      args: rpcArgs(this.cfg("mode", "default"), resume, this.cfg("trustProject", false)),
      cwd: root.uri.fsPath,
      onEvent: (e) => this.event(e),
      onExit: () => {
        this.running = false;
        this.paint();
        this.broadcast({ type: "host", running: false, problem: this.problem });
      },
      onProblem: (m) => {
        this.problem = m;
        this.broadcast({ type: "host", running: this.running, problem: m });
      },
    });
    this.running = true;
    this.client.start();
    this.paint();
    return true;
  }

  private fail(message: string): void {
    this.problem = message;
    this.broadcast({ type: "host", running: this.running, problem: message });
    void vscode.window.showWarningMessage(message);
  }

  restart(resume = false): void {
    this.client?.stop();
    this.client = undefined;
    this.ensure(resume);
  }

  private event(e: RpcEvent): void {
    this.state = reduce(this.state, e);
    this.broadcast({ type: "event", event: e });
    this.paint();
    if (e.type === "dialog" && e.dialog.kind === "approval" && e.dialog.id !== this.lastAsked) {
      this.lastAsked = e.dialog.id;
      // Only tells you; the answer is given in the panel, where the whole request is shown.
      if (![...this.views].length || !this.visible)
        void vscode.window.showWarningMessage(`Mnemo is asking to use ${e.dialog.tool}: ${e.dialog.subject.slice(0, 80)}`, "Review").then((pick) => pick && void vscode.commands.executeCommand("mnemo.open"));
    }
  }

  visible = false;

  private paint(): void {
    const asking = this.state.dialog?.kind === "approval";
    const working = !!this.state.working;
    this.bar.text = asking ? "$(bell) Mnemo: asking" : working ? "$(sync~spin) Mnemo" : "$(hubot) Mnemo";
    this.bar.tooltip = asking ? "Mnemo is waiting for your answer" : working ? "Mnemo is working" : this.running ? "Mnemo" : "Open Mnemo";
    this.bar.backgroundColor = asking ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
  }

  private broadcast(message: unknown): void {
    for (const v of this.views) void v.postMessage(message);
  }

  themeChanged(): void {
    this.broadcast({ type: "config", theme: this.cfg("theme", "editor") });
  }

  /** A webview (the side view or an editor tab) is shown; give it everything so far. */
  attach(webview: vscode.Webview, onDispose: vscode.Event<void>): void {
    this.views.add(webview);
    onDispose(() => this.views.delete(webview));
    webview.onDidReceiveMessage((m) => this.fromWebview(webview, m));
  }

  private fromWebview(webview: vscode.Webview, m: any): void {
    switch (m?.type) {
      case "ready":
        this.ensure();
        void webview.postMessage({ type: "snapshot", theme: this.cfg("theme", "editor"), state: this.state, running: this.running, problem: this.problem, version: this.context.extension.packageJSON.version });
        return;
      case "cmd": {
        const msg = forwardable(m.msg);
        if (!msg) return;
        if (!this.client?.send(msg)) void webview.postMessage({ type: "host", running: false, problem: "Mnemo is not running." });
        return;
      }
      case "request": {
        const msg = forwardable(m.msg);
        if (!msg || !this.client) return;
        void this.client.request(msg).then((r) => void webview.postMessage({ type: "response", key: m.key, result: r }));
        return;
      }
      case "setTheme":
        // Only a name the panel knows is stored; the setting's enum is the whitelist.
        if (typeof m.theme === "string" && THEME_VALUES.includes(m.theme)) void vscode.workspace.getConfiguration("mnemo").update("theme", m.theme, vscode.ConfigurationTarget.Global);
        return;
      case "restart":
        return this.restart();
      case "openSettings":
        void vscode.commands.executeCommand("workbench.action.openSettings", "@ext:selfev.mnemo-vscode");
        return;
      case "openFile":
        return void this.openFile(String(m.path ?? ""), typeof m.line === "number" ? m.line : undefined);
      case "copy":
        if (typeof m.text === "string") void vscode.env.clipboard.writeText(m.text);
        return;
    }
  }

  private async openFile(rel: string, line?: number): Promise<void> {
    const root = this.folder();
    if (!root || !rel) return;
    const real = (p: string) => {
      try {
        return fs.realpathSync.native(p);
      } catch {
        return p;
      }
    };
    const abs = real(path.resolve(root.uri.fsPath, rel));
    if (!relativeTo(real(root.uri.fsPath), abs)) return void vscode.window.showWarningMessage("That file is outside the project folder.");
    const doc = await vscode.workspace.openTextDocument(abs).then(undefined, () => undefined);
    if (!doc) return void vscode.window.showWarningMessage(`Could not open ${rel}`);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    if (line && line > 0) {
      const p = new vscode.Position(Math.min(line, doc.lineCount) - 1, 0);
      editor.selection = new vscode.Selection(p, p);
      editor.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenter);
    }
  }

  /** Put text in the composer (not sent) and bring the panel up. */
  prefill(text: string): void {
    this.ensure();
    void vscode.commands.executeCommand("mnemo.open").then(() => this.broadcast({ type: "prefill", text }));
  }

  tab(name: string): void {
    this.ensure();
    void vscode.commands.executeCommand("mnemo.open").then(() => this.broadcast({ type: "tab", tab: name }));
  }

  send(message: Record<string, unknown>): void {
    if (this.ensure()) this.client?.send(message);
  }

  dispose(): void {
    this.client?.stop();
    this.bar.dispose();
  }
}

function html(webview: vscode.Webview, root: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString("base64");
  const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(root, "media", ...p));
  const csp = [`default-src 'none'`, `style-src ${webview.cspSource}`, `script-src 'nonce-${nonce}' ${webview.cspSource}`, `font-src ${webview.cspSource}`].join("; ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${uri("webview.css")}"></head><body><div id="app"></div><script nonce="${nonce}" type="module" src="${uri("dist", "webview", "main.js")}"></script></body></html>`;
}

function realpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const session = new Session(context);
  context.subscriptions.push(
    session,
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("mnemo.theme") && session.themeChanged()),
  );

  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(view) {
      view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")] };
      view.webview.html = html(view.webview, context.extensionUri);
      session.attach(view.webview, view.onDidDispose);
      session.visible = view.visible;
      view.onDidChangeVisibility(() => (session.visible = view.visible));
    },
  };
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW, provider, { webviewOptions: { retainContextWhenHidden: true } }));

  let terminal: vscode.Terminal | undefined;
  const openTerminal = (resume: boolean) => {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) return void vscode.window.showWarningMessage("Open a folder first: Mnemo works in a project.");
    if (!vscode.workspace.isTrusted) return void vscode.window.showWarningMessage("Mnemo runs commands and edits files; trust this workspace first.");
    if (terminal && terminal.exitStatus === undefined) return terminal.show();
    terminal = vscode.window.createTerminal({ name: "Mnemo", shellPath: vscode.workspace.getConfiguration("mnemo").get("path", "mnemo"), shellArgs: launchArgs(vscode.workspace.getConfiguration("mnemo").get("mode", "default"), resume), cwd: root.uri.fsPath });
    terminal.show();
  };

  const selection = (): { rel: string; range?: { start: number; end: number }; code?: string; language: string } | undefined => {
    const editor = vscode.window.activeTextEditor;
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!editor || !root) return undefined;
    const rel = relativeTo(realpath(root.uri.fsPath), realpath(editor.document.uri.fsPath));
    if (!rel) return void vscode.window.showWarningMessage("That file is outside the project folder.");
    const s = editor.selection;
    if (s.isEmpty) return { rel, language: editor.document.languageId };
    const endLine = s.end.character === 0 && s.end.line > s.start.line ? s.end.line : s.end.line + 1;
    return { rel, range: { start: s.start.line + 1, end: endLine }, code: editor.document.getText(s).slice(0, 20000), language: editor.document.languageId };
  };

  const command = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    command("mnemo.open", async () => {
      session.ensure();
      await vscode.commands.executeCommand(`${VIEW}.focus`);
    }),
    command("mnemo.openInTab", () => {
      session.ensure();
      const panel = vscode.window.createWebviewPanel("mnemo.tab", "Mnemo", vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")] });
      panel.webview.html = html(panel.webview, context.extensionUri);
      session.attach(panel.webview, panel.onDidDispose);
    }),
    command("mnemo.continue", () => session.restart(true)),
    command("mnemo.restart", () => session.restart()),
    command("mnemo.newSession", () => session.send({ type: "submit", text: "/new" })),
    command("mnemo.stop", () => session.send({ type: "interrupt" })),
    command("mnemo.sendSelection", () => {
      const s = selection();
      if (s) session.prefill(composerDraft(s.rel, s.range, s.code, s.language));
    }),
    command("mnemo.sendFile", (uri?: vscode.Uri) => {
      const root = vscode.workspace.workspaceFolders?.[0];
      const file = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!root || !file) return;
      const rel = relativeTo(realpath(root.uri.fsPath), realpath(file.fsPath));
      if (!rel) return void vscode.window.showWarningMessage("That file is outside the project folder.");
      session.prefill(reference(rel));
    }),
    command("mnemo.showChanges", () => vscode.commands.executeCommand("workbench.view.scm")),
    command("mnemo.memory", () => session.tab("memory")),
    command("mnemo.settings", () => session.tab("settings")),
    command("mnemo.openTerminal", () => openTerminal(false)),
  );
}

export function deactivate(): void {}
