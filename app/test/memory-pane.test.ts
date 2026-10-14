/**
 * The memory pane's keys, on a real sidecar: e gives a fact a new value, d
 * forgets it, and - on a recalled item twice stops it being recalled.
 */
import { test, expect, afterEach } from "bun:test";
import { projectIdentity } from "@mnemo/memory";
import { workspaceSource } from "../src/runtime/workspace-source.ts";
import { MEMSRV, mnemoEnv, nextDialog } from "./helpers.ts";

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});

test.skipIf(!MEMSRV)("e edits a fact, d forgets it, - twice drops a recalled item", async () => {
  const e = await mnemoEnv({ memory: true });
  envs.push(e);
  const mem = e.memory!;
  const id = projectIdentity(e.cwd).id;
  const source = workspaceSource(e.controller, e.host, e.home);
  await mem.learn("project", id, "package manager", "pnpm");

  const editing = source.act("memory", "p:package manager", "e");
  const ask = await nextDialog(e.controller);
  if (ask.kind !== "text") throw new Error(`expected text, got ${ask.kind}`);
  expect(ask.initial).toBe("pnpm");
  ask.resolve("bun");
  await editing;
  expect((await mem.profile("project", id)).find((f) => f.key === "package manager")?.value).toBe("bun");
  expect((await source.memory()).find((i) => i.id === "p:package manager")?.detail).toBe("bun");

  const forgetting = source.act("memory", "p:package manager", "d");
  const sure = await nextDialog(e.controller);
  if (sure.kind !== "confirm") throw new Error(`expected confirm, got ${sure.kind}`);
  sure.resolve(true);
  await forgetting;
  expect((await source.memory()).some((i) => i.id === "p:package manager")).toBe(false);

  const node = (await mem.remember("release builds are signed with the team key in vault"))!;
  const query = "how are release builds signed";
  expect((await mem.recall(query, undefined, [])).some((h) => h.node === node)).toBe(true);
  await source.act("memory", `r:${node}`, "-");
  await source.act("memory", `r:${node}`, "-");
  expect((await mem.recall(query, undefined, [])).some((h) => h.node === node)).toBe(false);
});

test.skipIf(!MEMSRV)("what a turn recalled is listed under Recalled this session", async () => {
  const { fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai");
  const e = await mnemoEnv({ memory: true });
  envs.push(e);
  const node = (await e.memory!.remember("release builds are signed with the team key in vault"))!;
  e.faux.setResponses([fauxAssistantMessage(fauxText("ok"))]);
  await e.controller.submit("how are release builds signed here?");
  await e.idle();
  const items = await workspaceSource(e.controller, e.host, e.home).memory();
  expect(items.some((i) => i.id === "h:recalled")).toBe(true);
  expect(items.some((i) => i.id === `r:${node}`)).toBe(true);
});

test.skipIf(!MEMSRV)("memsrv that does not answer is not answering, not off and not empty", async () => {
  const e = await mnemoEnv({ memory: true });
  envs.push(e);
  e.memory!.stats = async () => undefined;
  const items = await workspaceSource(e.controller, e.host, e.home).memory();
  expect(items.map((i) => i.label)).toEqual(["memory is not answering"]);
});
