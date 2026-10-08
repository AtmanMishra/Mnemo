/**
 * Asking the sidecar what it knows, in the words the panel draws.
 *
 * The join between two things that were built separately: the client that speaks
 * the sidecar's protocol, and the formatter that turns its answer into lines.
 * Kept as its own small function because this is where a failure has to become a
 * *sentence* — the client reports `{ ok: false, error }` and the panel needs
 * something a person can act on, which is a decision worth having in one place.
 *
 * When the sidecar cannot answer, the reason it gave is carried through verbatim
 * and the fix is named. "Memory did not answer" alone would send the reader
 * looking at the model, the interface, or their own command; the two lines here
 * send them to the thing that is actually wrong.
 */
import { summarizeMemory, type MemorySummary } from "./panel.ts";

/** The slice of the client this needs — so a test can be a plain object. */
export interface MemoryReader {
  request(method: string, params?: Record<string, unknown>): Promise<{
    ok: boolean;
    result?: unknown;
    error?: string;
  }>;
}

export interface ReadOptions {
  /** How many nodes to draw. */
  limit?: number;
}

export async function readMemory(reader: MemoryReader, options: ReadOptions = {}): Promise<MemorySummary> {
  const answer = await reader.request("dump");

  if (!answer.ok) {
    return {
      lines: [
        "memory: the sidecar did not answer",
        `  ${answer.error ?? "no reason given"}`,
        "  check mnemo doctor — the memory layer may not be built or may not be reachable",
      ],
      total: 0,
      failed: true,
    };
  }

  return summarizeMemory(answer.result, options);
}
