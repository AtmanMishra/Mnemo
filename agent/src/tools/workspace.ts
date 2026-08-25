/**
 * Workspace root used to resolve relative paths for file tools.
 * Defaults to the process working directory; tests can point it at a temp dir.
 */
import * as path from "node:path";

let workspaceRoot = process.cwd();

export function getWorkspaceRoot(): string {
  return workspaceRoot;
}

export function setWorkspaceRoot(root: string): void {
  workspaceRoot = path.resolve(root);
}

export function resolveInWorkspace(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(workspaceRoot, p);
}
