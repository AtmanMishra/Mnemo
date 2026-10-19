/**
 * A folder's own settings, skills, prompts, extensions and `mcp.json` live in `.agents/`,
 * the folder other agents already read, not in pi's `.pi/`. pi takes that name from the
 * `piConfig.configDir` of the package.json at `PI_PACKAGE_DIR` when its config module
 * loads, so this module writes one and points the variable at it. It must run before
 * anything imports pi: bun-setup.ts imports it first, and bunfig.toml preloads it for tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

// Not @mnemo/memory's mnemoHome: this runs before anything else, and the end-to-end suite has no node_modules.
const mnemoHome = (env: NodeJS.ProcessEnv) => env.MNEMO_HOME?.trim() || path.join(os.homedir(), ".mnemo");

export const PROJECT_DIR = ".agents";

type Env = Record<string, string | undefined>;

/** pi's own version when it can be read from disk (not from inside a compiled binary). */
function piVersion(): string | undefined {
  try {
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    for (let dir = path.dirname(entry); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      const file = path.join(dir, "package.json");
      if (!fs.existsSync(file)) continue;
      const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
      return pkg.name === "@earendil-works/pi-coding-agent" ? pkg.version : undefined;
    }
  } catch {
    /* compiled binary or unresolvable: pi falls back to its own default */
  }
  return undefined;
}

/** What a folder still keeps under pi's old `.pi/` that Mnemo no longer reads, for a one-line notice. */
export function strandedPiResources(cwd: string): string[] {
  const names = ["extensions", "settings.json", "mcp.json", "skills", "prompts", "themes", "SYSTEM.md", "APPEND_SYSTEM.md"];
  return names.filter((n) => fs.existsSync(path.join(cwd, ".pi", n)) && !fs.existsSync(path.join(cwd, PROJECT_DIR, n)));
}

export function useProjectDir(env: Env = process.env): void {
  // Someone who points pi at a package directory on purpose (a Nix store path) keeps it.
  if (env.PI_PACKAGE_DIR) return;
  const dir = path.join(mnemoHome(env), "pi-package");
  const text = JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: piVersion(), piConfig: { configDir: PROJECT_DIR } }, null, 2) + "\n";
  const file = path.join(dir, "package.json");
  try {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, text);
    }
    env.PI_PACKAGE_DIR = dir;
  } catch {
    /* an unwritable home: pi keeps `.pi`, and the trust prompt names what it loads */
  }
}

useProjectDir();
