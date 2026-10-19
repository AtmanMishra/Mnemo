/** `mnemo skills …`: skill bundles pinned by hash. Read-only: installing writes text, nothing runs. */
import * as path from "node:path";
import { parseBundle, sha256 } from "./bundle.ts";
import { install, readLock, remove, verifyAll } from "./store.ts";
import { read } from "./source.ts";

export const SKILLS_USAGE = `mnemo skills — skill bundles, pinned by hash

usage
  mnemo skills inspect <file|https-url>                 what a bundle holds, and the SHA-256 to pin
  mnemo skills install <file|https-url> --sha256 <hash> install it, only if its hash is the one you read
  mnemo skills catalog <file|https-url>                 the bundles a catalog lists, with their pins
  mnemo skills install <name> --catalog <file|https-url> install a catalog's entry at the catalog's pin
  mnemo skills list                                     installed bundles and whether they are intact
  mnemo skills verify                                   check every installed bundle against its pin
  mnemo skills remove <name>

A bundle is one JSON file {name, version, description, files}. Installing writes its text files to
~/.mnemo/market/<name>/ and nothing else: no code runs. A bundle loads only while every file is
exactly what was pinned. Nothing updates itself: to take a new version, inspect it, remove the old one
and install again. A skill is instructions the model follows, so read it first.`;

interface Entry {
  name: string;
  description?: string;
  url: string;
  sha256: string;
}

function catalog(bytes: Uint8Array, base: string): Entry[] {
  const raw = JSON.parse(new TextDecoder().decode(bytes)) as { skills?: unknown };
  if (!Array.isArray(raw.skills)) throw new Error('a catalog is {"skills": [{name, url, sha256}]}');
  return raw.skills.map((e: Record<string, unknown>) => {
    if (typeof e?.name !== "string" || typeof e.url !== "string" || typeof e.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(e.sha256)) throw new Error("a catalog entry needs name, url and a 64-digit sha256");
    // A relative address is a file beside a catalog that is a file; beside a URL it is not guessed at.
    const url = /^https:\/\//i.test(e.url) || path.isAbsolute(e.url) ? e.url : /^https:\/\//i.test(base) ? e.url : path.join(path.dirname(base), e.url);
    return { name: e.name, description: typeof e.description === "string" ? e.description : undefined, url, sha256: e.sha256.toLowerCase() };
  });
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
}

export async function skillsCommand(argv: string[], home: string): Promise<number> {
  const [sub, ...rest] = argv;
  const fail = (msg: string) => (console.error(`mnemo skills: ${msg}`), 1);
  try {
    if (sub === "--help" || sub === "help" || sub === undefined) return console.log(SKILLS_USAGE), 0;
    if (sub === "inspect" || (sub === "install" && !rest.includes("--catalog") && !rest.includes("--sha256"))) {
      const src = rest[0];
      if (!src) return fail(`${sub} needs a file or https address`);
      const bytes = await read(src);
      const b = parseBundle(bytes);
      console.log(`${b.name} ${b.version}${b.description ? ` — ${b.description}` : ""}\nSHA-256 ${sha256(bytes)}\n`);
      for (const [p, text] of Object.entries(b.files)) console.log(`  ${p} (${text.length} chars)`);
      console.log(`\n--- SKILL.md ---\n${b.files["SKILL.md"]}\n--- end ---`);
      if (sub === "install") return fail(`nothing installed: read it, then run again with --sha256 ${sha256(bytes)}`);
      return 0;
    }
    if (sub === "catalog") {
      const src = rest[0];
      if (!src) return fail("catalog needs a file or https address");
      for (const e of catalog(await read(src), src)) console.log(`${e.name}\t${e.sha256.slice(0, 12)}\t${e.description ?? ""}`);
      return 0;
    }
    if (sub === "install") {
      const pinFlag = flag(rest, "--sha256");
      const cat = flag(rest, "--catalog");
      let src = rest[0];
      let pin = pinFlag;
      if (cat) {
        const entry = catalog(await read(cat), cat).find((e) => e.name === rest[0]);
        if (!entry) return fail(`${cat} lists no "${rest[0] ?? ""}"`);
        src = entry.url;
        pin = entry.sha256;
      }
      if (!src || !pin || !/^[0-9a-f]{64}$/i.test(pin)) return fail("install needs a source and a 64-digit --sha256");
      const { bundle, locked } = install(home, await read(src), src, pin);
      console.log(`installed ${bundle.name} ${bundle.version} (${Object.keys(locked.files).length} files), pinned at ${locked.sha256}`);
      return 0;
    }
    if (sub === "list") {
      const lock = readLock(home);
      const { bad } = verifyAll(home);
      if (!Object.keys(lock).length) return console.log("no installed bundles"), 0;
      for (const [name, l] of Object.entries(lock)) console.log(`${name}\t${l.version}\t${bad.find((b) => b.name === name)?.reason ?? "intact"}\t${l.source}`);
      return 0;
    }
    if (sub === "verify") {
      const { ok, bad } = verifyAll(home);
      for (const n of ok) console.log(`${n}: intact`);
      for (const b of bad) console.error(`${b.name}: NOT LOADED, ${b.reason}`);
      return bad.length ? 1 : 0;
    }
    if (sub === "remove") {
      if (!rest[0]) return fail("remove needs a name");
      return remove(home, rest[0]) ? (console.log(`removed ${rest[0]}`), 0) : fail(`${rest[0]} is not installed`);
    }
    return fail(`unknown command "${sub}"\n${SKILLS_USAGE}`);
  } catch (e) {
    return fail((e as Error).message);
  }
}

