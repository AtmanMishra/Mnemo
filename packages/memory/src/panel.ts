/**
 * What memory knows, as lines.
 *
 * The sidecar answers `dump` with the nodes it holds. A reader wants three
 * things from that and no more: how much is there, what it is about, and — when
 * it holds nothing — why that is normal rather than broken. Everything else is
 * a detail for the panel's own scrolling.
 *
 * The rule this file keeps: **an empty memory is described, not apologised
 * for.** A brand-new installation holding nothing is the expected state, and a
 * screen implying a fault would teach people to distrust a feature that is
 * working exactly as designed.
 */
export interface MemoryNode {
  label?: string;
  kind?: string;
  area?: string;
  state?: string;
}

export interface MemorySummary {
  /** The lines to draw, in order. */
  lines: string[];
  /** How many nodes the answer actually contained. */
  total: number;
  /** True when the answer was unusable and the lines say so. */
  failed: boolean;
}

const DEFAULT_LIMIT = 8;

function nodesOf(result: unknown): MemoryNode[] | undefined {
  if (!result || typeof result !== "object") return undefined;
  const nodes = (result as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return undefined;
  return nodes.filter((node): node is MemoryNode => Boolean(node) && typeof node === "object");
}

/** One node, drawn the way a reader would say it out loud. */
export function describeNode(node: MemoryNode): string {
  const name = node.label?.trim() || "(unlabelled)";
  const parts = [name];
  if (node.area) parts.push(`[${node.area}]`);
  if (node.kind && node.kind !== "fact") parts.push(node.kind);
  if (node.state) parts.push(`— ${node.state}`);
  return parts.join(" ");
}

/**
 * Turn a `dump` answer into the lines a panel shows.
 *
 * `null` means the sidecar did not answer at all, which is a different sentence
 * from "it answered with nothing" — one is a missing feature, the other is a
 * young installation, and only one of them is the reader's problem.
 */
export function summarizeMemory(result: unknown, options: { limit?: number } = {}): MemorySummary {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const nodes = nodesOf(result);

  if (!nodes) {
    return {
      lines: ["memory: no answer from the sidecar", "  check mnemo doctor — the memory layer may not be built"],
      total: 0,
      failed: true,
    };
  }
  if (nodes.length === 0) {
    return {
      lines: [
        "memory: empty",
        "  nothing learned yet — it records as you work, not only when asked",
      ],
      total: 0,
      failed: false,
    };
  }

  const shown = nodes.slice(0, Math.max(0, limit)).map((node) => `  ${describeNode(node)}`);
  const hidden = nodes.length - shown.length;
  return {
    lines: [
      `memory: ${nodes.length} node${nodes.length === 1 ? "" : "s"}`,
      ...shown,
      ...(hidden > 0 ? [`  …and ${hidden} more`] : []),
    ],
    total: nodes.length,
    failed: false,
  };
}
