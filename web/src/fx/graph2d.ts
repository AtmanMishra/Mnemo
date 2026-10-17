// The memory you can poke: a small force-directed graph on a canvas, drawn as pixel
// blocks with inked outlines. It acts out what the memory layer really does: a session
// recalls what it needs (pulses run to it along the edges), leaves a fact behind, and a
// changed fact supersedes the old one, which stays in the graph as history.
import { token } from "./theme";

export type Kind = "project" | "fact" | "pitfall" | "skill" | "session" | "open";

export interface GNode {
  id: string;
  kind: Kind;
  label: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  retired?: boolean;
  born: number;
}

interface GEdge {
  a: string;
  b: string;
  kind: "part" | "derived" | "supersedes";
}

interface Pulse {
  from: string;
  to: string;
  t: number;
}

const COLOR: Record<Kind, string> = {
  project: "--violet",
  fact: "--cyan",
  pitfall: "--magenta",
  skill: "--green",
  session: "--mustard",
  open: "--salmon",
};

const START: [string, Kind, string][] = [
  ["proj", "project", "mnemo-demo"],
  ["lang", "fact", "language: TypeScript"],
  ["pm", "fact", "package manager: pnpm"],
  ["http", "fact", "getJson retries 5xx"],
  ["pit", "pitfall", "tests hang on :3000 → --runInBand"],
  ["skill", "skill", "run-checks before done"],
  ["open", "open", "no test for the retry path"],
  ["s1", "session", "add a retry to fetch"],
];
const START_EDGES: GEdge[] = [
  { a: "lang", b: "proj", kind: "part" },
  { a: "pm", b: "proj", kind: "part" },
  { a: "http", b: "proj", kind: "part" },
  { a: "pit", b: "proj", kind: "part" },
  { a: "skill", b: "proj", kind: "part" },
  { a: "open", b: "http", kind: "derived" },
  { a: "s1", b: "http", kind: "derived" },
  { a: "s1", b: "open", kind: "derived" },
];

// Sessions a visitor can run, what each recalls, and what it leaves behind.
const SESSIONS: { label: string; recalls: string[]; learns: [Kind, string] }[] = [
  { label: "test the retry path", recalls: ["http", "open", "pit"], learns: ["fact", "retry test: src/fetch.test.ts"] },
  { label: "add a rate limit", recalls: ["http", "skill"], learns: ["fact", "rate limit: 10 req/s per host"] },
  { label: "fix the flaky CI job", recalls: ["pit", "skill"], learns: ["pitfall", "CI cache stale → key on lockfile"] },
  { label: "bump dependencies", recalls: ["pm", "skill"], learns: ["skill", "bump-deps: one package a commit"] },
  { label: "write the README", recalls: ["lang", "proj"], learns: ["fact", "docs live in docs/, not the wiki"] },
];

// Facts that change: the new value supersedes the old, which is kept.
const CHANGES: [string, string][] = [
  ["pm", "package manager: bun"],
  ["http", "getJson retries 5xx and 429"],
  ["lang", "language: TypeScript, strict"],
];

export interface GraphApi {
  newSession(): string;
  changeFact(): string;
  destroy(): void;
}

export function createGraph(canvas: HTMLCanvasElement, opts: { reduced: boolean }): GraphApi {
  const ctx = canvas.getContext("2d")!;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W = 0, H = 0;
  const size = () => {
    const r = canvas.getBoundingClientRect();
    W = r.width;
    H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  };
  size();
  const ro = new ResizeObserver(size);
  ro.observe(canvas);

  const now = () => performance.now();
  const nodes: GNode[] = START.map(([id, kind, label], i) => {
    const a = (i / START.length) * Math.PI * 2;
    return { id, kind, label, x: W / 2 + Math.cos(a) * 120, y: H / 2 + Math.sin(a) * 90, vx: 0, vy: 0, born: -1e9 };
  });
  const edges: GEdge[] = [...START_EDGES];
  const pulses: Pulse[] = [];
  const byId = (id: string) => nodes.find((n) => n.id === id);
  let sessionN = 0;
  let changed = 0;

  const step = () => {
    const cx = W / 2, cy = H / 2;
    for (const n of nodes) {
      for (const m of nodes) {
        if (n === m) continue;
        const dx = n.x - m.x, dy = n.y - m.y;
        const d2 = Math.max(80, dx * dx + dy * dy);
        const f = 2600 / d2;
        n.vx += (dx / Math.sqrt(d2)) * f;
        n.vy += (dy / Math.sqrt(d2)) * f;
      }
      n.vx += (cx - n.x) * 0.004;
      n.vy += (cy - n.y) * 0.006;
    }
    for (const e of edges) {
      const a = byId(e.a)!, b = byId(e.b)!;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const f = (d - (e.kind === "supersedes" ? 70 : 95)) * 0.02;
      a.vx += (dx / d) * f;
      a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f;
      b.vy -= (dy / d) * f;
    }
    for (const n of nodes) {
      if (n === drag) continue;
      n.vx *= 0.82;
      n.vy *= 0.82;
      n.x = Math.min(W - 20, Math.max(20, n.x + n.vx));
      n.y = Math.min(H - 20, Math.max(20, n.y + n.vy));
    }
  };

  const half = (n: GNode) => (n.kind === "project" ? 13 : 9);

  const draw = () => {
    const ink = token("--ink"), panel = token("--panel"), rule = token("--rule"), red = token("--magenta"), dim = token("--dim");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // Halftone dot ground.
    ctx.fillStyle = rule;
    for (let y = 12; y < H; y += 18) for (let x = (y / 18) % 2 ? 12 : 21; x < W; x += 18) ctx.fillRect(x, y, 2, 2);

    for (const e of edges) {
      const a = byId(e.a)!, b = byId(e.b)!;
      ctx.strokeStyle = e.kind === "supersedes" ? red : ink;
      ctx.globalAlpha = e.kind === "part" ? 0.45 : 0.8;
      ctx.lineWidth = e.kind === "part" ? 1.5 : 2;
      ctx.setLineDash(e.kind === "supersedes" ? [5, 5] : []);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    for (const p of pulses) {
      const a = byId(p.from)!, b = byId(p.to)!;
      const t = Math.min(1, p.t);
      ctx.fillStyle = red;
      ctx.fillRect(a.x + (b.x - a.x) * t - 4, a.y + (b.y - a.y) * t - 4, 8, 8);
    }

    ctx.font = '500 11px "DM Mono", ui-monospace, monospace';
    ctx.textBaseline = "middle";
    for (const n of nodes) {
      const age = Math.min(1, (now() - n.born) / 500);
      const s = half(n) * (opts.reduced ? 1 : 0.4 + 0.6 * (1 - Math.pow(1 - age, 3)));
      ctx.globalAlpha = n.retired ? 0.5 : 1;
      ctx.fillStyle = ink;
      ctx.fillRect(n.x - s + 3, n.y - s + 3, s * 2, s * 2);
      ctx.fillStyle = n.retired ? panel : token(COLOR[n.kind]);
      ctx.fillRect(n.x - s, n.y - s, s * 2, s * 2);
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2;
      ctx.setLineDash(n.retired ? [3, 3] : []);
      ctx.strokeRect(n.x - s, n.y - s, s * 2, s * 2);
      ctx.setLineDash([]);
      const show = n === hover || n === drag || n.kind === "project" || now() - n.born < 3200 || W > 700;
      if (show) {
        const label = n.retired ? `${n.label} (history)` : n.label;
        const tw = ctx.measureText(label).width;
        const lx = Math.min(W - tw - 8, n.x + s + 8);
        ctx.fillStyle = panel;
        ctx.globalAlpha = n.retired ? 0.6 : 0.92;
        ctx.fillRect(lx - 4, n.y - 9, tw + 8, 18);
        ctx.globalAlpha = n.retired ? 0.7 : 1;
        ctx.fillStyle = n === hover ? ink : dim;
        ctx.fillText(label, lx, n.y + 1);
      }
      ctx.globalAlpha = 1;
    }
  };

  let raf = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    step();
    for (const p of pulses) p.t += 0.018;
    while (pulses.length && pulses[0]!.t > 1.3) pulses.shift();
    draw();
  };
  if (opts.reduced) {
    for (let i = 0; i < 400; i++) step();
    draw();
  } else raf = requestAnimationFrame(loop);
  const settle = () => {
    if (!opts.reduced) return;
    for (let i = 0; i < 300; i++) step();
    draw();
  };

  // Pointer: drag a node, hover to read it.
  let drag: GNode | null = null;
  let hover: GNode | null = null;
  const at = (ev: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    return { x, y, n: nodes.find((n) => Math.abs(n.x - x) < half(n) + 6 && Math.abs(n.y - y) < half(n) + 6) ?? null };
  };
  const down = (ev: PointerEvent) => {
    const p = at(ev);
    if (!p.n) return;
    drag = p.n;
    canvas.setPointerCapture(ev.pointerId);
    canvas.classList.add("grabbing");
  };
  const move = (ev: PointerEvent) => {
    const p = at(ev);
    if (drag) {
      drag.x = p.x;
      drag.y = p.y;
      drag.vx = drag.vy = 0;
      if (opts.reduced) draw();
    } else if (hover !== p.n) {
      hover = p.n;
      canvas.classList.toggle("grab", !!hover);
      if (opts.reduced) draw();
    }
  };
  const up = () => {
    drag = null;
    canvas.classList.remove("grabbing");
    settle();
  };
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);

  const add = (kind: Kind, label: string, near: GNode) => {
    const n: GNode = { id: `n${nodes.length}`, kind, label, x: near.x + (Math.random() - 0.5) * 60, y: near.y + (Math.random() - 0.5) * 60, vx: 0, vy: 0, born: now() };
    nodes.push(n);
    return n;
  };

  return {
    newSession() {
      const plan = SESSIONS[sessionN % SESSIONS.length]!;
      sessionN++;
      const proj = byId("proj")!;
      const s = add("session", plan.label, proj);
      for (const id of plan.recalls) {
        const r = byId(id);
        if (!r) continue;
        edges.push({ a: s.id, b: r.id, kind: "derived" });
        pulses.push({ from: r.id, to: s.id, t: -Math.random() * 0.3 });
      }
      // Reflection after the run leaves something behind.
      const learned = add(plan.learns[0], plan.learns[1], s);
      learned.born = now() + 900;
      edges.push({ a: learned.id, b: proj.id, kind: "part" }, { a: learned.id, b: s.id, kind: "derived" });
      settle();
      return `Session "${plan.label}" recalled ${plan.recalls.length} memories and wrote down: ${plan.learns[1]}.`;
    },
    changeFact() {
      const c = CHANGES[changed];
      const old = c && byId(c[0]);
      if (!c || !old) return "Each of these facts has changed once. Run a session to give it more to learn.";
      changed++;
      old.retired = true;
      const n = add("fact", c[1], old);
      edges.push({ a: n.id, b: old.id, kind: "supersedes" }, { a: n.id, b: "proj", kind: "part" });
      settle();
      return `"${old.label}" is superseded by "${c[1]}". The old value stays, marked as history.`;
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
    },
  };
}
