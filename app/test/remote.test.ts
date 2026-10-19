import { afterEach, expect, test } from "bun:test";
import * as net from "node:net";
import { mnemoEnv, texts } from "./helpers.ts";

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function setup() {
  const env = await mnemoEnv();
  closers.push(() => env.close());
  await env.controller.submit("/remote");
  const link = /http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{64}/.exec(texts(env.controller).join("\n"))?.[0];
  if (!link) throw new Error(`no link in ${texts(env.controller).join("|")}`);
  closers.push(() => env.controller.submit("/remote off"));
  const u = new URL(link);
  return { env, link, port: Number(u.port), token: u.searchParams.get("t")! };
}

/** A raw request, so the Host header can be anything. */
function raw(port: number, method: string, path: string, headers: Record<string, string>): Promise<{ status: number; headers: string; body: string }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    let data = "";
    s.on("data", (d) => (data += d));
    s.on("close", () => {
      const [head, ...rest] = data.split("\r\n\r\n");
      resolve({ status: Number(/HTTP\/1\.1 (\d+)/.exec(head)?.[1]), headers: head.toLowerCase(), body: rest.join("\r\n\r\n") });
    });
    s.on("error", reject);
    const h = Object.entries({ host: `127.0.0.1:${port}`, connection: "close", ...headers }).map(([k, v]) => `${k}: ${v}`);
    s.write(`${method} ${path} HTTP/1.1\r\n${h.join("\r\n")}\r\n\r\n`);
  });
}

test("remote view is off until /remote, and listens on loopback only", async () => {
  const env = await mnemoEnv();
  closers.push(() => env.close());
  expect(texts(env.controller).join()).not.toContain("127.0.0.1");
  const { link, port } = await setup();
  expect(link.startsWith("http://127.0.0.1:")).toBe(true);
  // Not reachable by a non-loopback address of this machine.
  const other = Object.values((await import("node:os")).networkInterfaces()).flat().find((i) => i && !i.internal && i.family === "IPv4")?.address;
  if (other) await expect(fetch(`http://${other}:${port}/`)).rejects.toBeDefined();
});

test("the token is needed; the link turns into a cookie; the page is locked down", async () => {
  const { port, token } = await setup();
  expect((await raw(port, "GET", "/", {})).status).toBe(401);
  expect((await raw(port, "GET", "/?t=" + "0".repeat(64), {})).status).toBe(401);
  expect((await raw(port, "GET", "/events", {})).status).toBe(401);
  const hop = await raw(port, "GET", `/?t=${token}`, {});
  expect(hop.status).toBe(302);
  expect(hop.headers).toContain("httponly");
  expect(hop.headers).toContain("samesite=strict");
  expect(hop.headers).toContain("referrer-policy: no-referrer");
  const cookie = `mnemo_remote=${token}`;
  const page = await raw(port, "GET", "/", { cookie });
  expect(page.status).toBe(200);
  expect(page.headers).toContain("content-security-policy: default-src 'none'");
  expect(page.headers).not.toContain("access-control-allow");
  // The token in the address bar of a later request is not accepted in place of the cookie.
  expect((await raw(port, "GET", `/events?t=${token}`, {})).status).toBe(401);
});

test("a foreign Host, Origin or site, and any method but GET, are refused even with the cookie", async () => {
  const { port, token } = await setup();
  const cookie = `mnemo_remote=${token}`;
  expect((await raw(port, "GET", "/", { cookie, host: "evil.example" })).status).toBe(403);
  expect((await raw(port, "GET", "/", { cookie, host: `evil.example:${port}` })).status).toBe(403);
  expect((await raw(port, "GET", "/", { cookie, origin: "https://evil.example" })).status).toBe(403);
  expect((await raw(port, "GET", "/", { cookie, "sec-fetch-site": "cross-site" })).status).toBe(403);
  for (const m of ["POST", "PUT", "DELETE", "OPTIONS"]) expect((await raw(port, m, "/", { cookie })).status).toBe(405);
  expect((await raw(port, "GET", "/", { cookie, host: `localhost:${port}` })).status).toBe(200);
});

test("the event stream shows the session, redacted, without approvals, and follows changes", async () => {
  const { env, port, token } = await setup();
  const secret = "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4";
  env.controller.transcript.push({ kind: "user", text: `my key is ${secret}` });
  const res = await fetch(`http://127.0.0.1:${port}/events`, { headers: { cookie: `mnemo_remote=${token}` } });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  const until = async (needle: string) => {
    const end = Date.now() + 3000;
    while (!text.includes(needle) && Date.now() < end) {
      const r = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 500))]);
      if (r && !r.done) text += dec.decode(r.value);
    }
    expect(text).toContain(needle);
  };
  await until("my key is");
  expect(text).not.toContain(secret);
  expect(text).not.toContain("dialog");
  env.controller.transcript.push({ kind: "user", text: "second message" });
  await until("second message");
  await reader.cancel();
});

test("/remote off stops the server, and a new start has a new token", async () => {
  const { env, port, token, link } = await setup();
  await env.controller.submit("/remote off");
  await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toBeDefined();
  await env.controller.submit("/remote");
  const links = texts(env.controller).join("\n").match(/\?t=[0-9a-f]{64}/g)!;
  expect(links.length).toBe(2);
  expect(links[1]).not.toBe(`?t=${token}`);
  expect(link).toContain(token);
});
