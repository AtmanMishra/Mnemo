// `bun build --compile` cannot follow an `import()` whose specifier is computed at run
// time: the target file is simply not in the binary. Every source-run test still passes,
// and the feature fails only for users (that is how subscription login broke in 0.1.0
// through 0.1.2). This bundles the entry point the way the release build does and fails
// on any computed import() it has not been told about, so a dependency upgrade that adds
// one is caught here instead of in a release.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const app = path.join(import.meta.dir, "..");
const setup = fs.readFileSync(path.join(app, "src", "runtime", "bun-setup.ts"), "utf8");

/** Each known site, by the name of the function around it, and why the binary is fine with it. */
const KNOWN: { name: RegExp; why: string; ok: () => boolean }[] = [
  { name: /importOAuthModule/, why: "pi-ai's OAuth login flows: bun-setup registers bundled copies", ok: () => /registerBunOAuthFlows\(\)/.test(setup) },
  { name: /importNodeOnlyApi/, why: "pi-ai's Bedrock provider: bun-setup registers the bundled module", ok: () => /setBedrockProviderModule\(/.test(setup) },
  { name: /importNodeModule|dynamicImport/, why: "pi-ai reading node:fs / node:os / node:path, which every runtime has", ok: () => true },
  { name: /nativeImport|jiti\.import|createJitiImpl/, why: "user extensions (.pi/extensions, ~/.mnemo/agent/extensions) loaded from disk by path", ok: () => true },
];

test("every computed import() in the binary is accounted for", async () => {
  const stub = {
    name: "stub-react-devtools",
    setup(b: Bun.PluginBuilder) {
      b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default {}", loader: "js" }));
    },
  };
  const built = await Bun.build({ entrypoints: [path.join(app, "bin", "mnemo.ts")], target: "bun", plugins: [stub], minify: false });
  expect(built.success).toBe(true);
  const code = await built.outputs[0]!.text();

  const unknown: string[] = [];
  const seen = new Set<string>();
  // A call: `import(` after something that ends an expression start, not `.import(` (a method)
  // and not `async import(` (a method definition), with an identifier-first argument.
  for (const m of code.matchAll(/(?<![.\w$])import\(\s*([A-Za-z_$][\w$.]*)/g)) {
    const before = code.slice(Math.max(0, m.index! - 300), m.index!);
    if (/async\s*$/.test(before)) continue;
    const site = KNOWN.find((k) => k.name.test(before.slice(-200)));
    if (!site) {
      unknown.push(`import(${m[1]}…) after: …${before.slice(-160).replace(/\s+/g, " ")}`);
      continue;
    }
    seen.add(site.why);
    if (!site.ok()) unknown.push(`${site.why}: but src/runtime/bun-setup.ts no longer handles it`);
  }
  expect(unknown).toEqual([]);
  // The two that need registering must still be there: if a pi upgrade renames them, the
  // check above would pass by finding nothing, so make that a failure too.
  expect([...seen]).toEqual(expect.arrayContaining([KNOWN[0]!.why, KNOWN[1]!.why]));

  // A module that reads files next to itself gets the build machine's directory baked in.
  // On a user's machine that path does not exist; each one must be handled.
  const baked = [...code.matchAll(/var __dirname = "([^"]+)"/g)].map((m) => m[1]!);
  const unhandled = baked.filter((dir) => !(dir.includes("photon-node") && /photon_rs_bg\.wasm/.test(setup)));
  expect(unhandled).toEqual([]);
}, 120_000);
