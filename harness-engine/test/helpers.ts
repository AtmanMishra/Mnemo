import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TestTool {
  name: string;
  description?: string;
  schema?: unknown;
  source?: string;
}

/** Full-module form source (contains export default). */
export function moduleSource(tool: {
  name: string;
  returns?: string; // JS expression
  imports?: string[];
}): string {
  const imports = (tool.imports ?? []).map((s) => `import ${JSON.stringify(s)};`).join("\n");
  return `${imports}
const schema = { type: "object", properties: {}, required: [] };
export default {
  name: ${JSON.stringify(tool.name)},
  description: "test tool ${tool.name}",
  schema,
  async execute(params) {
    return ${tool.returns ?? JSON.stringify(`ran:${tool.name}`)};
  },
};
`;
}

export function bodySource(returnExpr: string): string {
  return `return ${returnExpr};`;
}

export async function makeTmpDir(prefix = "harness-engine-test-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeBundleDir(
  root: string,
  bundleName: string,
  tools: TestTool[],
  version = "0.1.0",
): Promise<string> {
  const dir = path.join(root, bundleName);
  await fs.mkdir(path.join(dir, "tools"), { recursive: true });
  const manifest = {
    name: bundleName,
    version,
    description: `test bundle ${bundleName}`,
    tools: tools.map((t) => `tools/${t.name}.mjs`),
  };
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");
  for (const t of tools) {
    const src =
      t.source ??
      moduleSource({ name: t.name, returns: JSON.stringify(`ran:${bundleName}:${t.name}`) });
    await fs.writeFile(path.join(dir, `tools/${t.name}.mjs`), src, "utf8");
  }
  return dir;
}

/** Poll a predicate until it holds or the deadline passes. Returns elapsed ms. */
export async function waitFor(
  pred: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 25,
): Promise<number> {
  const start = Date.now();
  for (;;) {
    if (await pred()) return Date.now() - start;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
