/**
 * What a compiled binary needs before anything else runs. pi-ai loads its OAuth
 * login flows and its Bedrock provider through variable `import()` specifiers so
 * bundlers cannot follow them; inside `bun build --compile` those files do not
 * exist, so `/login` with a subscription failed with "Cannot find module
 * './anthropic.js'" and Bedrock could not load. pi's own binary registers static
 * copies in `pi-coding-agent/dist/bun/runtime-setup.js`; this does the same.
 * Harmless when running from source: the static copies are the same modules.
 *
 * Not mirrored from pi's setup: `setEmbeddedQuickJSWasmPath` (the codemode VM). pi does
 * not export it, and Mnemo registers no codemode extension.
 */
// Before anything that reads the environment as it loads (see sandbox-env.ts).
import "./sandbox-env.ts";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/compat";

process.title = "mnemo";
// As pi's binary does: Node-compat deprecation and experimental notices would print over the interface.
process.emitWarning = () => {};
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);

// pi decodes and resizes images with photon, whose loader reads `photon_rs_bg.wasm` from
// the directory it was installed in: in a binary that is the build machine's path, so on
// a user's machine every image `read` came back "Image omitted". The module is embedded
// here and any read of that one file name that misses on disk is answered from it.
import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" };
import { createRequire } from "node:module";

const cjsFs = createRequire(import.meta.url)("fs") as typeof import("node:fs");
const readFileSync = cjsFs.readFileSync;
cjsFs.readFileSync = ((file: Parameters<typeof readFileSync>[0], options?: unknown) => {
  try {
    return readFileSync(file, options as never);
  } catch (error) {
    const name = typeof file === "string" ? file : file instanceof URL ? file.pathname : "";
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && name.endsWith("photon_rs_bg.wasm") && name !== photonWasm)
      return readFileSync(photonWasm, options as never);
    throw error;
  }
}) as typeof readFileSync;
