import * as vscode from "vscode";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { launchArgs, reference, relativeTo } from "./core";

/**
 * Mnemo has no machine-readable interface (`-p` prints one answer and, per
 * docs/SECURITY-AUDIT-2026-10.md, allows every call that would ask). So this
 * extension never drives the agent behind the user's back: it opens the real
 * interface in an editor terminal, where Mnemo's own approval prompt decides
 * each command and edit, and adds editor commands around it.
 */

let terminal: vscode.Terminal | undefined;
let output: vscode.OutputChannel | undefined;

function folder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

function setting<T>(name: string, fallback: T): T {
  return vscode.workspace.getConfiguration("mnemo").get<T>(name, fallback);
}

function open(resume: boolean): vscode.Terminal | undefined {
  const root = folder();
  if (!root) {
    void vscode.window.showWarningMessage("Open a folder first: Mnemo works in a project.");
    return undefined;
  }
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage("Mnemo runs commands and edits files; trust this workspace first.");
    return undefined;
  }
  if (terminal && terminal.exitStatus === undefined) {
    terminal.show();
    return terminal;
  }
  terminal = vscode.window.createTerminal({
    name: "Mnemo",
    shellPath: setting("path", "mnemo"),
    shellArgs: launchArgs(setting("mode", "default"), resume),
    cwd: root.uri.fsPath,
  });
  terminal.show();
  return terminal;
}

/** Type a reference into Mnemo's input without pressing enter: the user adds the question and sends it. */
function send(text: string): void {
  const t = open(false);
  if (t) t.sendText(text, false);
}

function sendSelection(): void {
  const editor = vscode.window.activeTextEditor;
  const root = folder();
  if (!editor || !root) return;
  const rel = relativeTo(realpath(root.uri.fsPath), realpath(editor.document.uri.fsPath));
  if (!rel) return void vscode.window.showWarningMessage("That file is outside the project folder.");
  if (editor.document.isDirty) void vscode.window.showInformationMessage("Mnemo reads the saved file; save to include your edits.");
  const s = editor.selection;
  send(reference(rel, s.isEmpty ? undefined : { start: s.start.line + 1, end: s.end.character === 0 && s.end.line > s.start.line ? s.end.line : s.end.line + 1 }));
}

function sendFile(uri?: vscode.Uri): void {
  const root = folder();
  const file = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!root || !file) return;
  const rel = relativeTo(realpath(root.uri.fsPath), realpath(file.fsPath));
  if (!rel) return void vscode.window.showWarningMessage("That file is outside the project folder.");
  send(reference(rel));
}

function realpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

function memoryStatus(): void {
  const root = folder();
  output ??= vscode.window.createOutputChannel("Mnemo");
  output.show(true);
  execFile(setting("path", "mnemo"), ["memory", "status"], { cwd: root?.uri.fsPath, timeout: 20_000 }, (error, stdout, stderr) => {
    output!.appendLine(error ? `mnemo memory status failed: ${(stderr || error.message).trim()}` : stdout.trim());
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  bar.text = "$(hubot) Mnemo";
  bar.tooltip = "Open Mnemo";
  bar.command = "mnemo.open";
  bar.show();

  const command = (id: string, fn: (...args: any[]) => void) => vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    bar,
    command("mnemo.open", () => open(false)),
    command("mnemo.continue", () => open(true)),
    command("mnemo.sendSelection", sendSelection),
    command("mnemo.sendFile", sendFile),
    // Mnemo edits files in place, so the editor's own source control view is the diff.
    command("mnemo.showChanges", () => vscode.commands.executeCommand("workbench.view.scm")),
    command("mnemo.memoryStatus", memoryStatus),
    vscode.window.onDidCloseTerminal((t) => {
      if (t === terminal) terminal = undefined;
    }),
  );
}

export function deactivate(): void {}
