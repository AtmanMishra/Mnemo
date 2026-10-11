// The installers have one source (app/scripts); the site serves copies so the page,
// the release asset and the repository always carry the same script. Reading from
// outside web/ needs Vercel's "Include source files outside of the Root Directory"
// (on by default); if it is off this fails loudly instead of shipping a site
// without /install.sh.
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scripts = resolve(here, "../../app/scripts");
const out = resolve(here, "../public");
mkdirSync(out, { recursive: true });

for (const [from, to] of [["get.sh", "install.sh"], ["get.ps1", "install.ps1"]]) {
  const src = resolve(scripts, from);
  try {
    if (statSync(src).size === 0) throw new Error("empty");
  } catch (e) {
    console.error(`cannot read ${src}: ${e.message}. On Vercel, enable "Include source files outside of the Root Directory in the Build Step".`);
    process.exit(1);
  }
  copyFileSync(src, resolve(out, to));
  console.log(`${from} -> public/${to}`);
}
