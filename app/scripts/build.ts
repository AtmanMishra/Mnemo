/**
 * `bun run build` — one self-contained `mnemo` binary (no Bun or Node needed
 * on the machine that runs it).
 *
 *   bun scripts/build.ts                     this platform → dist/mnemo
 *   bun scripts/build.ts bun-linux-arm64     a cross target → dist/mnemo-bun-linux-arm64
 *
 * Ink imports `react-devtools-core` for its optional devtools; nothing installs
 * it, and `--compile` fails on the unresolved import. It is replaced by a stub.
 */
import * as path from "node:path";

const target = process.argv[2];
const outfile = path.join(import.meta.dir, "..", "dist", target ? `mnemo-${target}` : "mnemo");

const stubDevtools = {
  name: "stub-react-devtools",
  setup(build: Bun.PluginBuilder) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default { initialize() {}, connectToDevTools() {} };",
      loader: "js",
    }));
  },
};

const result = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "..", "bin", "mnemo.ts")],
  compile: target ? { outfile, target: target as Bun.Build.CompileTarget } : { outfile },
  plugins: [stubDevtools],
  minify: true,
  sourcemap: "linked",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built ${path.relative(process.cwd(), outfile)}`);
