/**
 * 4.5: image input. Fixtures are built byte-by-byte here so the test proves
 * the sniffing, not a checked-in PNG someone might replace.
 */
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MAX_IMAGE_BYTES, humanBytes, readImageTool, sniffMimeType,
} from "../src/tools/read_image.ts";
import { setWorkspaceRoot } from "../src/tools/workspace.ts";
import { textOf } from "../src/tools/types.ts";
import { toToolContent } from "../src/mcp.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = Buffer.concat([
  Buffer.from([0x52, 0x49, 0x46, 0x46]), Buffer.from([0, 0, 0, 0]),
  Buffer.from([0x57, 0x45, 0x42, 0x50]),
]);

function workspace(name: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `mnemo-img-${name}-`));
  setWorkspaceRoot(d);
  return d;
}

test("the format comes from the bytes, not the extension", () => {
  assert.equal(sniffMimeType(PNG), "image/png");
  assert.equal(sniffMimeType(JPEG), "image/jpeg");
  assert.equal(sniffMimeType(GIF), "image/gif");
  assert.equal(sniffMimeType(WEBP), "image/webp");
  assert.equal(sniffMimeType(Buffer.from("#!/bin/sh\nrm -rf /")), null);
  assert.equal(sniffMimeType(Buffer.alloc(0)), null);
  // RIFF without the WEBP marker is some other RIFF container (wav, avi)
  assert.equal(sniffMimeType(Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])), null);
});

test("an image is returned as an image block with a text caption", async () => {
  const dir = workspace("ok");
  fs.writeFileSync(path.join(dir, "shot.png"), PNG);

  const res = await readImageTool.execute("id", { path: "shot.png" });
  assert.equal(res.content.length, 2);
  // caption first, so a model that cannot see images still knows what it got
  assert.equal(res.content[0]!.type, "text");
  assert.match(textOf(res), /shot\.png/);
  assert.match(textOf(res), /image\/png/);

  const image = res.content[1] as any;
  assert.equal(image.type, "image");
  assert.equal(image.mimeType, "image/png");
  assert.equal(Buffer.from(image.data, "base64").toString("hex"), PNG.toString("hex"),
    "the bytes must survive the base64 round trip exactly");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a file that is not an image is refused, whatever it is called", async () => {
  const dir = workspace("liar");
  fs.writeFileSync(path.join(dir, "evil.png"), "#!/bin/sh\nrm -rf /");
  await assert.rejects(() => readImageTool.execute("id", { path: "evil.png" }),
    /not a PNG, JPEG, GIF or WebP/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an oversized image is refused before it is read into memory", async () => {
  const dir = workspace("big");
  const big = path.join(dir, "big.png");
  fs.writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES + 1)]));
  await assert.rejects(() => readImageTool.execute("id", { path: "big.png" }),
    /over the 5\.0 MB limit/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a missing file says which path it tried", async () => {
  const dir = workspace("missing");
  await assert.rejects(() => readImageTool.execute("id", { path: "nope.png" }), /cannot read/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sizes read as sizes", () => {
  assert.equal(humanBytes(512), "512 B");
  assert.equal(humanBytes(2048), "2.0 KB");
  assert.equal(humanBytes(5 * 1024 * 1024), "5.0 MB");
});

test("an MCP server's image block reaches the model as an image", () => {
  const content = toToolContent([
    { type: "text", text: "here is the chart" },
    { type: "image", data: "aGk=", mimeType: "image/jpeg" },
  ]);
  assert.equal(content.length, 2);
  assert.deepEqual(content[0], { type: "text", text: "here is the chart" });
  assert.deepEqual(content[1], { type: "image", data: "aGk=", mimeType: "image/jpeg" });

  // an image without a declared type still goes through, defaulted
  const defaulted = toToolContent([{ type: "image", data: "aGk=" }]) as any;
  assert.equal(defaulted[0].mimeType, "image/png");

  // and anything else is still reduced to text rather than dropped
  const other = toToolContent([{ type: "resource", resource: { text: "body" } }]);
  assert.deepEqual(other, [{ type: "text", text: "body" }]);
  assert.deepEqual(toToolContent([]), [{ type: "text", text: "" }]);
});
