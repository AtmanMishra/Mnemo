/**
 * `/remote`: a read-only web view of this session, for a second screen.
 *
 * Off until the user types `/remote`, then a server on 127.0.0.1 only, on a random port, behind a
 * random token that exists for this start alone. Every request is checked: the Host must be the
 * loopback address and port we gave out (a page on another site cannot reach us through DNS
 * rebinding), a request that names another Origin is refused, only GET is served, and no CORS
 * header is ever sent. The token comes in once, in the link, and moves to an HttpOnly,
 * SameSite=Strict cookie. Nothing a viewer sends changes the session: there is no command, no
 * answer to an approval, and the approvals themselves are not shown. To read it from another
 * machine, tunnel the port (`ssh -L`): Mnemo never binds a public address.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { redact } from "@mnemo/memory";
import type { Controller } from "./controller.ts";

const COOKIE = "mnemo_remote";
const MAX_CLIENTS = 4;
const MAX_BLOCKS = 200;
const MAX_TEXT = 4000;
const THROTTLE_MS = 100;
const KEEPALIVE_MS = 15_000;

const same = (a: string, b: string): boolean => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

/** Every string in `v`, redacted and cut short: the view must not show more than the screen would, nor a secret in it. */
function clean(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return redact(v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}…` : v);
  if (depth > 6 || v === null || typeof v !== "object") return typeof v === "function" ? undefined : v;
  if (Array.isArray(v)) return v.map((x) => clean(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x, depth + 1)]));
}

export class RemoteView {
  private server?: ReturnType<typeof Bun.serve>;
  private token = "";
  private clients = new Set<(chunk: string) => void>();
  private unsubscribe: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private last = "";

  constructor(private readonly c: Controller) {}

  /** The link to open, or undefined when it is off. */
  get url(): string | undefined {
    return this.server ? `http://127.0.0.1:${this.server.port}/?t=${this.token}` : undefined;
  }

  get running(): boolean {
    return this.server !== undefined;
  }

  start(): string {
    if (this.server) return this.url!;
    this.token = randomBytes(32).toString("hex");
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: (req) => this.handle(req) });
    const schedule = () => {
      if (this.timer) return;
      this.timer = setTimeout(() => ((this.timer = undefined), this.push()), THROTTLE_MS);
    };
    this.unsubscribe.push(this.c.transcript.subscribe(schedule), this.c.subscribe(schedule));
    const roster = this.c.host?.roster;
    if (roster) this.unsubscribe.push(roster.subscribe(schedule));
    return this.url!;
  }

  stop(): void {
    for (const u of this.unsubscribe.splice(0)) u();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.clients.clear();
    this.server?.stop(true);
    this.server = undefined;
    this.token = "";
    this.last = "";
  }

  /** The whole view, as plain data. Approvals and settings are left out on purpose. */
  private snapshot(): string {
    const t = this.c.transcript.snapshot();
    const chrome = this.c.snapshot();
    const roster = this.c.host?.roster.snapshot().nodes ?? [];
    return JSON.stringify(
      clean({
        blocks: [...t.committed, ...t.live].slice(-MAX_BLOCKS),
        working: t.working,
        footer: chrome.footer,
        agents: roster.map((n) => ({ id: n.id, parent: n.parent, label: n.label, task: n.task, status: n.status, steps: n.stepCount })),
      }),
    );
  }

  private push(): void {
    if (!this.clients.size) return;
    const data = this.snapshot();
    if (data === this.last) return;
    this.last = data;
    for (const send of this.clients) send(`data: ${data}\n\n`);
  }

  private authorized(req: Request, url: URL): boolean {
    const cookie = req.headers.get("cookie")?.split(/;\s*/).find((p) => p.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    return cookie !== undefined && same(cookie, this.token) && url.searchParams.get("t") === null;
  }

  private handle(req: Request): Response {
    const port = this.server?.port;
    const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
    const refuse = (status: number, text: string) => new Response(text, { status, headers });
    if (req.method !== "GET") return refuse(405, "read-only");
    const host = req.headers.get("host");
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return refuse(403, "wrong host");
    const origin = req.headers.get("origin");
    if (origin !== null && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return refuse(403, "wrong origin");
    const site = req.headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin" && site !== "none") return refuse(403, "cross-site");
    const url = new URL(req.url);

    // The link carries the token once; it becomes a cookie and the address bar is cleaned.
    const t = url.searchParams.get("t");
    if (url.pathname === "/" && t !== null) {
      if (!same(t, this.token)) return refuse(401, "bad token");
      return new Response(null, { status: 302, headers: { ...headers, location: "/", "set-cookie": `${COOKIE}=${this.token}; HttpOnly; SameSite=Strict; Path=/` } });
    }
    if (!this.authorized(req, url)) return refuse(401, "open the link /remote printed");

    if (url.pathname === "/") {
      return new Response(PAGE, { headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" } });
    }
    if (url.pathname === "/events") {
      if (this.clients.size >= MAX_CLIENTS) return refuse(429, "too many viewers");
      let send!: (chunk: string) => void;
      let ping: ReturnType<typeof setInterval>;
      const stream = new ReadableStream<string>({
        start: (ctl) => {
          send = (chunk) => {
            try {
              ctl.enqueue(chunk);
            } catch {
              this.clients.delete(send);
            }
          };
          this.clients.add(send);
          send(`data: ${this.snapshot()}\n\n`);
          ping = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS);
        },
        cancel: () => {
          this.clients.delete(send);
          clearInterval(ping);
        },
      });
      return new Response(stream.pipeThrough(new TextEncoderStream()), { headers: { ...headers, "content-type": "text/event-stream" } });
    }
    return refuse(404, "not found");
  }
}

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mnemo</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1b1f;--dim:#6b6b76;--line:#d8d8e0;--accent:#6c4bd8}
@media(prefers-color-scheme:dark){:root{--bg:#141418;--fg:#e6e6ee;--dim:#8d8d9a;--line:#2c2c36;--accent:#a28bff}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:8px 16px;color:var(--dim);font-size:13px;display:flex;gap:12px;flex-wrap:wrap}
main{max-width:860px;margin:0 auto;padding:12px 16px 64px}
.b{margin:10px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.user{border-left:3px solid var(--accent);padding-left:10px}
.tool,.thinking,.notice,.memory,.peer{color:var(--dim);font:13px/1.45 ui-monospace,monospace}
.out{max-height:12em;overflow:auto;border:1px solid var(--line);padding:6px;margin-top:4px}
#agents{color:var(--dim);font-size:13px}
</style>
<header><b>Mnemo</b><span id="foot">connecting…</span><span>read-only</span></header>
<main><div id="agents"></div><div id="log"></div></main>
<script>
const log=document.getElementById("log"),foot=document.getElementById("foot"),agents=document.getElementById("agents");
function el(cls,text){const d=document.createElement("div");d.className="b "+cls;d.textContent=text;return d}
function render(s){
  const f=s.footer||{};foot.textContent=[f.model,f.mode,f.cwd,f.branch&&("⎇ "+f.branch),s.working?"working…":"idle"].filter(Boolean).join(" · ");
  agents.textContent=(s.agents||[]).length>1?s.agents.map(a=>a.label+" ("+a.status+")").join(" · "):"";
  const near=innerHeight+scrollY>=document.body.scrollHeight-80;
  log.replaceChildren(...s.blocks.map(b=>{
    if(b.kind==="user")return el("user",b.text);
    if(b.kind==="assistant")return el("assistant",b.text);
    if(b.kind==="thinking")return el("thinking","thinking: "+b.text);
    if(b.kind==="tool"){const d=el("tool",b.name+" "+(b.status||"")+" "+JSON.stringify(b.args||{}).slice(0,300));if(b.output){const o=document.createElement("div");o.className="out";o.textContent=b.output;d.appendChild(o)}return d}
    if(b.kind==="peer")return el("peer",b.label+": "+b.text);
    if(b.kind==="memory")return el("memory",b.title+"\\n"+(b.items||[]).join("\\n"));
    if(b.kind==="notice")return el("notice",b.text);
    return el("notice","");
  }));
  if(near)scrollTo(0,document.body.scrollHeight);
}
const es=new EventSource("/events");
es.onmessage=e=>render(JSON.parse(e.data));
es.onerror=()=>{foot.textContent="disconnected (the session may have ended or /remote off)"};
</script>`;
