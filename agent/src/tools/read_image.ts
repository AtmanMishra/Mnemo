/**
 * 4.5 read_image: put a picture in front of the model.
 *
 * pi's tool results already carry {type:"image", data, mimeType} blocks, so
 * this needs no protocol work — only reading the file, proving it really is an
 * image, and refusing ones too large to be worth the context.
 *
 * The type is detected from the file's magic bytes rather than its extension:
 * a .png that is actually a 200MB video should be refused, not forwarded.
 */
import * as fs from "node:fs/promises";
import { Type } from "typebox";
import { resolveInWorkspace } from "./workspace.ts";
import { imageResult, type SeaTool } from "./types.ts";

/** base64 inflates by ~4/3, and an image is worth thousands of tokens. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Magic-byte sniffing for the formats models actually accept. */
export function sniffMimeType(bytes: Uint8Array): string | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  // RIFF....WEBP
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45
      && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

export function humanBytes(n: number): string {
  return n < 1024 ? `${n} B`
    : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const readImageTool: SeaTool = {
  name: "read_image",
  label: "Read image",
  description:
    "Read a PNG, JPEG, GIF or WebP image from the workspace and show it to the model. " +
    "Use for screenshots, diagrams and design mockups.",
  parameters: Type.Object({
    path: Type.String({ description: "Image path (absolute or relative to workspace root)." }),
  }),
  async execute(_id, params) {
    const abs = resolveInWorkspace(params.path);

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(abs);
    } catch (err: any) {
      throw new Error(`read_image: cannot read ${abs}: ${err?.message ?? err}`);
    }
    if (stat.size > MAX_IMAGE_BYTES) {
      throw new Error(
        `read_image: ${abs} is ${humanBytes(stat.size)}, over the ` +
        `${humanBytes(MAX_IMAGE_BYTES)} limit. Resize or crop it first.`,
      );
    }

    const buf = await fs.readFile(abs);
    const mimeType = sniffMimeType(buf);
    if (!mimeType) {
      throw new Error(
        `read_image: ${abs} is not a PNG, JPEG, GIF or WebP ` +
        `(checked the file's own bytes, not its extension).`,
      );
    }
    return imageResult(
      buf.toString("base64"),
      mimeType,
      `${params.path} (${mimeType}, ${humanBytes(stat.size)})`,
    );
  },
};
