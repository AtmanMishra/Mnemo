// The loading screen. It shows real work: the count and the line under it follow what
// the page waits for (fonts, the 3D library, compiling the shaders, building the memory
// graph, the page's images), and Mne's pixels arrive as that work does. When all of it
// is done the pixel elephant is handed to the stage, which draws the same picture in
// the same place, so the loader can go with nothing jumping: the stage then flies the
// elephant to its place on the page (src/fx/host.ts).
//
// The loader has no backdrop of its own. It hides the page's parts and shows the same
// sky the page uses, so there is nothing to lift away.
//
// It runs only when public/boot.js marked the page `booting` (scripts on, motion allowed).
import { PIXELS, SPRITE_W } from "./mne";
import { mulberry32 } from "../art/rng";
import { ELEPHANT_TOKENS, token } from "./theme";

export type Task = "type" | "three.js" | "shaders" | "memory graph" | "images" | "page";
const TASKS: [Task, string][] = [
  ["type", "setting the type"],
  ["three.js", "loading three.js"],
  ["shaders", "compiling the shaders"],
  ["memory graph", "building the memory graph"],
  ["images", "developing the pictures"],
  ["page", "finishing the page"],
];

type Handoff = (rect: DOMRect) => Promise<void> | void;

let resolveFinished!: () => void;
/** Resolves when the loader hands over (at once when there is none). */
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
  const minMs = seen ? 400 : 1600;

  // Shown by `booting` at first paint; `on` keeps it up while the page comes back.
  root.classList.add("on");
  root.innerHTML = `
    <div class="boot-card">
      <canvas class="boot-px"></canvas>
      <p class="boot-count">000</p>
      <p class="boot-task"></p>
    </div>`;
  const canvas = root.querySelector<HTMLCanvasElement>(".boot-px")!;
  const count = root.querySelector<HTMLElement>(".boot-count")!;
  const task = root.querySelector<HTMLElement>(".boot-task")!;

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
  // Nothing may hold the page hostage: whatever has not reported in 8 seconds counts as done.
  setTimeout(() => TASKS.forEach(([t]) => complete(t)), 8000);

  const ctx = canvas.getContext("2d")!;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let cell = 0;
  const size = () => {
    const s = Math.min(window.innerWidth, window.innerHeight);
    cell = Math.max(6, Math.floor((s * 0.34) / SPRITE_W));
    const px = cell * SPRITE_W;
    canvas.width = px * dpr;
    canvas.height = px * dpr;
    canvas.style.width = `${px}px`;
    canvas.style.height = `${px}px`;
  };
  size();
  window.addEventListener("resize", size);

  // Each pixel has its moment in the count; it pops in over a short beat when reached.
  const rand = mulberry32(7);
  const order = PIXELS.map(() => 0.04 + rand() * 0.92);
  const colors = ELEPHANT_TOKENS.map(token);
  const dot = token("--rule");
  const POP = 0.06;

  const draw = (p: number) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    PIXELS.forEach((px, i) => {
      const x = px.x * cell, y = px.y * cell;
      const k = Math.max(0, Math.min(1, (p - order[i]!) / POP));
      if (k <= 0) {
        // Not remembered yet: a dot where the pixel will be, so the shape is already there.
        ctx.fillStyle = dot;
        const d = Math.max(2, cell * 0.22);
        ctx.fillRect(x + (cell - d) / 2, y + (cell - d) / 2, d, d);
        return;
      }
      // A small overshoot as it lands; whole pixels once it has.
      const s = k >= 1 ? cell : cell * (0.3 + 0.85 * Math.sin((k * Math.PI) / 1.6));
      ctx.fillStyle = colors[px.c]!;
      ctx.fillRect(x + (cell - s) / 2, y + (cell - s) / 2, s, s);
    });
  };

  const t0 = performance.now();
  let shown = 0;
  const tick = () => {
    const elapsed = performance.now() - t0;
    const real = done.size / TASKS.length;
    const target = Math.min(real, elapsed / minMs);
    shown += (target - shown) * 0.12;
    if (target - shown < 0.002) shown = target;
    draw(shown * (1 + POP));
    count.textContent = String(Math.floor(shown * 100)).padStart(3, "0");
    const next = TASKS.find(([t]) => !done.has(t));
    task.textContent = next ? next[1] : "remembering";
    if (shown >= 1 && done.size === TASKS.length) void finish();
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const finish = async () => {
    window.removeEventListener("resize", size);
    draw(2);
    count.textContent = "100";
    const { default: gsap } = await import("gsap");
    await gsap.to([count, task], { opacity: 0, y: 10, duration: 0.3, stagger: 0.05, ease: "power2.in" }).then();
    // The page comes back first, still in its hidden starting states, so the browser
    // lays it out and paints it before anything moves, not halfway through the flight.
    const header = document.querySelector("header.top");
    if (header) gsap.set(header, { opacity: 0, y: -24 });
    html.classList.remove("booting");
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // The stage now draws the same elephant, flat and pixelated, in the same place.
    const rect = canvas.getBoundingClientRect();
    await handoff?.(rect);
    if (handoff) canvas.style.visibility = "hidden";
    if (header) gsap.to(header, { opacity: 1, y: 0, duration: 0.7, delay: 0.5, ease: "power3.out", clearProps: "opacity,transform" });
    active = false;
    resolveFinished();
    if (handoff) root.remove();
    else gsap.to(canvas, { opacity: 0, duration: 0.4, onComplete: () => root.remove() });
  };
}
