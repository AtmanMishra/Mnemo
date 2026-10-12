import { SPRITE_COLORS, SPRITE_H, SPRITE_ROWS, SPRITE_W } from "./sprite";
import { makeNoise, mulberry32 } from "./rng";

// Engram: a seeded field of characters that settles into Mne. See art/ENGRAM.md.

export interface EngramParams {
  seed: number;
  /** Cell size in CSS pixels. */
  cell: number;
  /** Scale of the drifting current: smaller is calmer. */
  flow: number;
  /** Speed of the current, in noise units per second. */
  drift: number;
  /** Seconds for the figure to finish settling. */
  settle: number;
  /** Radius of the pointer lantern, in cells. */
  recall: number;
}

export const DEFAULT_PARAMS: EngramParams = { seed: 7, cell: 11, flow: 0.11, drift: 0.32, settle: 3.4, recall: 6 };

export interface Engram {
  readonly seed: number;
  setSeed(seed: number): void;
  destroy(): void;
}

const RAMP = [" ", ".", ":", "+", "x", "*", "#"];
// The inks come from the page's theme tokens, read again when the theme changes.
const INK_TOKENS = ["--violet", "--cyan", "--magenta", "--amber"];
function readInks(): { inks: string[]; dim: string } {
  const css = getComputedStyle(document.documentElement);
  const get = (t: string, fallback: string) => css.getPropertyValue(t).trim() || fallback;
  return { inks: INK_TOKENS.map((t) => get(t, "#888")), dim: get("--faint", "#777") };
}
const FRAME_MS = 1000 / 40;
const RIPPLE_EVERY = 13;
const RIPPLE_SECONDS = 2.6;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function createEngram(
  canvas: HTMLCanvasElement,
  options: { reducedMotion: boolean; params?: Partial<EngramParams>; onFrame?: () => void },
): Engram {
  const params: EngramParams = { ...DEFAULT_PARAMS, ...options.params };
  const ctx = canvas.getContext("2d");
  if (!ctx) return { seed: params.seed, setSeed() {}, destroy() {} };
  const g = ctx;

  let cols = 0;
  let rows = 0;
  let width = 0;
  let height = 0;
  let target = new Int8Array(0); // sprite colour index per cell, -1 outside the figure
  let delay = new Float32Array(0);
  let noise = makeNoise(params.seed);
  let noiseInk = makeNoise(params.seed + 101);
  let t0 = performance.now();
  let raf = 0;
  let visible = true;
  let last = 0;
  let pointer: { x: number; y: number } | null = null;
  let firstFrame = true;
  let { inks: INKS, dim: DIM } = readInks();

  function layout() {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, Math.floor(rect.width));
    height = Math.max(1, Math.floor(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.max(1, Math.floor(width / params.cell));
    rows = Math.max(1, Math.floor(height / params.cell));
    buildTargets();
  }

  function buildTargets() {
    target = new Int8Array(cols * rows).fill(-1);
    delay = new Float32Array(cols * rows);
    const k = Math.max(1, Math.floor((Math.min(cols, rows) * 0.74) / SPRITE_W));
    const ox = Math.floor((cols - SPRITE_W * k) / 2);
    const oy = Math.floor((rows - SPRITE_H * k) / 2);
    const rand = mulberry32(params.seed * 7919 + 13);
    const cx = cols / 2;
    const cy = rows / 2;
    const reach = Math.hypot(SPRITE_W * k, SPRITE_H * k) / 2;
    for (let sy = 0; sy < SPRITE_H; sy++) {
      for (let sx = 0; sx < SPRITE_W; sx++) {
        const ch = SPRITE_ROWS[sy]![sx]!;
        if (ch === ".") continue;
        const colour = ch.charCodeAt(0) - 97;
        for (let dy = 0; dy < k; dy++) {
          for (let dx = 0; dx < k; dx++) {
            const x = ox + sx * k + dx;
            const y = oy + sy * k + dy;
            if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
            const i = y * cols + x;
            target[i] = colour;
            // The figure closes from several places at once: distance from the middle
            // sets the order, a seeded roll breaks it up.
            const radial = Math.hypot(x - cx, y - cy) / reach;
            delay[i] = params.settle * (0.12 + 0.46 * radial + 0.36 * rand());
          }
        }
      }
    }
  }

  function draw(t: number, animate: boolean) {
    g.clearRect(0, 0, width, height);
    const c = params.cell;
    g.font = `${c}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    const cx = cols / 2;
    const cy = rows / 2;
    const px = pointer ? pointer.x / c : -999;
    const py = pointer ? pointer.y / c : -999;
    const ringAge = animate ? (t - params.settle - 3) % RIPPLE_EVERY : -1;
    const ringR = ringAge >= 0 && ringAge < RIPPLE_SECONDS ? (ringAge / RIPPLE_SECONDS) * Math.max(cols, rows) * 0.42 : -1;
    const drift = animate ? t * params.drift : 0;

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        const n = noise(x * params.flow + drift, y * params.flow - drift * 0.6);
        const idx = target[i]!;
        const edge = 1 - smooth(0.55, 1, Math.hypot((x - cx) / cx, (y - cy) / cy));
        const lantern = pointer ? Math.max(0, 1 - Math.hypot(x - px, y - py) / params.recall) : 0;

        let p = idx >= 0 ? smooth(0, 0.9, t - delay[i]!) : 0;
        if (ringR >= 0 && idx >= 0) {
          const ring = Math.max(0, 1 - Math.abs(Math.hypot(x - cx, y - cy) - ringR) / 2.2);
          p *= 1 - ring;
        }

        const left = x * c;
        const top = y * c;
        if (idx >= 0 && p >= 1) {
          // Settled: a pixel. The lantern re-lights it a little.
          g.globalAlpha = 0.82 + 0.18 * Math.min(1, lantern * 1.4 + n * 0.4);
          g.fillStyle = SPRITE_COLORS[idx]!;
          g.fillRect(left + 0.5, top + 0.5, c - 1, c - 1);
          continue;
        }

        // Free (or settling): a glyph. Settling cells burn brighter on the way in.
        const strength = (idx >= 0 ? 0.35 + 0.65 * p : 0.62 * edge) * (0.35 + 0.9 * n) + lantern * 0.7;
        const level = Math.min(RAMP.length - 1, Math.floor(strength * RAMP.length));
        if (level <= 0) continue;
        const ink = Math.floor(noiseInk(x * 0.07 + 3, y * 0.07) * 6);
        g.globalAlpha = Math.min(1, 0.28 + strength * 0.75);
        g.fillStyle = lantern > 0.15 ? (ink % 2 ? INKS[1]! : INKS[3]!) : ink < INKS.length ? INKS[ink]! : DIM;
        g.fillText(RAMP[level]!, left + c / 2, top + c / 2 + 0.5);
      }
    }
    g.globalAlpha = 1;
    if (firstFrame) {
      firstFrame = false;
      options.onFrame?.();
    }
  }

  function tick(now: number) {
    raf = 0;
    if (!visible || document.hidden) return;
    if (now - last >= FRAME_MS) {
      last = now;
      draw((now - t0) / 1000, true);
    }
    raf = requestAnimationFrame(tick);
  }

  function start() {
    if (options.reducedMotion || raf || !visible || document.hidden) return;
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function still() {
    draw(params.settle + 2, false);
  }

  const resize = new ResizeObserver(() => {
    layout();
    if (options.reducedMotion) still();
  });
  const seen = new IntersectionObserver(([entry]) => {
    visible = !!entry?.isIntersecting;
    if (visible) start();
    else stop();
  });
  const onVisibility = () => (document.hidden ? stop() : start());
  const themed = new MutationObserver(() => {
    ({ inks: INKS, dim: DIM } = readInks());
    if (options.reducedMotion) still();
  });
  const onMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (options.reducedMotion) still();
  };
  const onLeave = () => {
    pointer = null;
    if (options.reducedMotion) still();
  };

  layout();
  resize.observe(canvas);
  seen.observe(canvas);
  themed.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("blur", onLeave);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("pointercancel", onLeave);
  if (options.reducedMotion) still();
  else start();

  return {
    get seed() {
      return params.seed;
    },
    setSeed(seed: number) {
      params.seed = seed;
      noise = makeNoise(seed);
      noiseInk = makeNoise(seed + 101);
      buildTargets();
      t0 = performance.now();
      if (options.reducedMotion) still();
    },
    destroy() {
      stop();
      resize.disconnect();
      seen.disconnect();
      themed.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onLeave);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointercancel", onLeave);
    },
  };
}
