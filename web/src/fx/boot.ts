// The loading screen. It shows real work: each line is something the page waits for
// (fonts, the 3D library, compiling the shaders, building the memory graph, the page's
// images), and Mne is drawn as ASCII that turns into pixels as those finish. When all
// of it is done the pixel elephant is handed to the stage, which draws the same picture
// underneath, so the loader can lift away with nothing jumping.
//
// It runs only when public/boot.js marked the page `booting` (scripts on, motion allowed).
import { PIXELS, SPRITE_W } from "./mne";
import { mulberry32 } from "../art/rng";
import { ELEPHANT_TOKENS, token } from "./theme";

export type Task = "type" | "three.js" | "shaders" | "memory graph" | "images" | "page";
const TASKS: Task[] = ["type", "three.js", "shaders", "memory graph", "images", "page"];

type Handoff = (rect: DOMRect) => Promise<void> | void;

let resolveFinished!: () => void;
/** Resolves once the loader is gone (at once when there is none). */
export const finished = new Promise<void>((r) => (resolveFinished = r));

const done = new Set<Task>();
let handoff: Handoff | null = null;
let active = false;

export const isBooting = () => active;

export function complete(task: Task) {
  done.add(task);
}

/** The stage registers here so the loader can hand it the elephant. */
export function onHandoff(fn: Handoff) {
  handoff = fn;
}

export function startBoot() {
  const html = document.documentElement;
  const root = document.getElementById("boot");
  if (!html.classList.contains("booting") || !root) {
    resolveFinished();
    return;
  }
  active = true;

  // A repeat visit in this tab still waits for the work, but not for the drawing.
  let seen = false;
  try {
    seen = sessionStorage.getItem("mnemo-booted") === "1";
    sessionStorage.setItem("mnemo-booted", "1");
  } catch {
    /* storage off: treat as a first visit */
  }
  const minMs = seen ? 500 : 2200;

  const ui = root.querySelector<HTMLElement>(".boot-ui")!;
  ui.innerHTML = `
    <div class="boot-card">
      <canvas class="boot-px"></canvas>
      <p class="boot-brand">Mnemo</p>
      <p class="boot-ribbon"><span>Loading memories</span></p>
      <div class="boot-bar"><i></i><span>000%</span></div>
      <ol class="boot-log">${TASKS.map((t) => `<li data-task="${t}"><span>${t}</span><b></b><em>····</em></li>`).join("")}</ol>
    </div>`;
  const canvas = root.querySelector<HTMLCanvasElement>(".boot-px")!;
  const bar = root.querySelector<HTMLElement>(".boot-bar i")!;
  const pct = root.querySelector<HTMLElement>(".boot-bar span")!;
  const rows = new Map(TASKS.map((t) => [t, root.querySelector<HTMLElement>(`[data-task="${t}"]`)!]));

  // Work every page has, tracked here; the stage reports its own.
  const fontsReady = Promise.all(
    ['400 1em "Alfa Slab One"', '400 1em "Arvo"', '400 1em "Silkscreen"', '400 1em "DM Mono"'].map((f) => document.fonts.load(f)),
  ).then(() => document.fonts.ready);
  void fontsReady.then(() => complete("type"), () => complete("type"));
  const images = () =>
    Promise.all(
      [...document.querySelectorAll<HTMLImageElement>("#root img")]
        .filter((img) => img.loading !== "lazy")
        .map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => {}))),
    );
  void images().then(() => complete("images"));
  if (document.readyState === "complete") complete("page");
  else window.addEventListener("load", () => complete("page"), { once: true });
  // Nothing may hold the page hostage: whatever has not reported in 9 seconds counts as done.
  setTimeout(() => TASKS.forEach(complete), 9000);

  const ctx = canvas.getContext("2d")!;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let cell = 0;
  const size = () => {
    const s = Math.min(window.innerWidth, window.innerHeight);
    cell = Math.max(6, Math.floor((s * 0.3) / SPRITE_W));
    const px = cell * SPRITE_W;
    canvas.width = px * dpr;
    canvas.height = px * dpr;
    canvas.style.width = `${px}px`;
    canvas.style.height = `${px}px`;
  };
  size();
  window.addEventListener("resize", size);

  const rand = mulberry32(7);
  const order = PIXELS.map(() => rand());
  const colors = ELEPHANT_TOKENS.map(token);
  const ink = token("--ink");
  const glyphs = "@%#*+=-:.";
  const t0 = performance.now();
  let shown = 0;

  const draw = (p: number) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `${Math.round(cell * 0.95)}px "DM Mono", ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    PIXELS.forEach((px, i) => {
      const o = order[i]!;
      const x = px.x * cell, y = px.y * cell;
      if (o < p) {
        ctx.fillStyle = colors[px.c]!;
        ctx.fillRect(x, y, cell, cell);
      } else {
        // Not loaded yet: the pixel is still a character, denser as it gets close.
        const k = Math.min(glyphs.length - 1, Math.floor(((o - p) / 0.6) * glyphs.length));
        ctx.globalAlpha = 0.35 + 0.65 * (1 - k / glyphs.length);
        ctx.fillStyle = colors[px.c] === colors[1] ? ink : colors[px.c]!;
        ctx.fillText(glyphs[k]!, x + cell / 2, y + cell / 2 + 1);
        ctx.globalAlpha = 1;
      }
    });
  };

  const tick = () => {
    const elapsed = performance.now() - t0;
    const real = done.size / TASKS.length;
    const target = Math.min(real, elapsed / minMs);
    shown += (target - shown) * 0.09;
    if (target - shown < 0.002) shown = target;
    draw(shown);
    bar.style.transform = `scaleX(${shown})`;
    pct.textContent = `${String(Math.floor(shown * 100)).padStart(3, "0")}%`;
    for (const [t, li] of rows) if (done.has(t) && !li.classList.contains("ok")) li.classList.add("ok");
    if (shown >= 1 && done.size === TASKS.length) void finish();
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const finish = async () => {
    window.removeEventListener("resize", size);
    draw(1);
    pct.textContent = "100%";
    const { default: gsap } = await import("gsap");
    const rect = canvas.getBoundingClientRect();
    // The stage now draws the same elephant, flat and pixelated, in the same place.
    await handoff?.(rect);
    html.classList.add("boot-lift");
    const tl = gsap.timeline({ defaults: { ease: "power3.inOut" } });
    tl.to(root.querySelectorAll(".boot-brand, .boot-ribbon, .boot-bar, .boot-log li"), { opacity: 0, y: -12, duration: 0.35, stagger: 0.03, ease: "power2.in" });
    tl.to(root.querySelectorAll(".boot-shutter"), { yPercent: -101, duration: 0.8, stagger: 0.07 }, ">-0.15");
    tl.to(canvas, { opacity: 0, duration: 0.2, ease: "none" }, handoff ? ">-0.1" : "<");
    await tl.then();
    root.remove();
    html.classList.remove("booting", "boot-lift");
    active = false;
    resolveFinished();
  };
}
