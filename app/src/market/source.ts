/**
 * Where a bundle or a catalog comes from: a file, or an https address the user typed. Mnemo
 * contacts nothing on its own; this runs only for a `mnemo skills` command that names one.
 */
import * as fs from "node:fs";
import { isMetadata } from "../policy/egress.ts";
import { MAX_BUNDLE } from "./bundle.ts";

const TIMEOUT_MS = 15_000;

export async function read(source: string, limit = MAX_BUNDLE): Promise<Uint8Array> {
  if (/^http:\/\//i.test(source)) throw new Error("only https:// addresses (or a file) are fetched");
  if (!/^https:\/\//i.test(source)) {
    const st = fs.statSync(source, { throwIfNoEntry: false });
    if (!st?.isFile()) throw new Error(`${source} is not a file`);
    if (st.size > limit) throw new Error(`${source} is larger than ${limit / 1024} KB`);
    return new Uint8Array(fs.readFileSync(source));
  }
  const url = new URL(source);
  if (isMetadata(url.hostname)) throw new Error(`${url.hostname} is a cloud metadata address and is refused`);
  // A redirect could lead anywhere, and the pin was made for what the user named.
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${source}: ${res.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > limit) throw new Error(`${source} is larger than ${limit / 1024} KB`);
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
