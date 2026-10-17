// The page change: the screen fills with blocks in bands of the palette, like a
// pixel dissolve on an old set, with the next page's name on a ribbon; the page is
// swapped underneath; then the blocks clear in the same order.
import { mulberry32 } from "../art/rng";
import { token } from "./theme";

const BLOCK = 44;
const BANDS = ["--magenta", "--mustard", "--cyan", "--salmon", "--ground"];

let canvas: HTMLCanvasElement | null = null;

function ensure(): HTMLCanvasElement {
  if (canvas?.isConnected) return canvas;
  canvas = document.createElement("canvas");
  canvas.className = "wipe";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  return canvas;
}

function run(label: string, from: number, to: number, ms: number): Promise<void> {
  const c = ensure();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth, h = window.innerHeight;
  c.width = Math.ceil(w * dpr);
  c.height = Math.ceil(h * dpr);
  const ctx = c.getContext("2d")!;
  const cols = Math.ceil(w / BLOCK), rows = Math.ceil(h / BLOCK);
  const rand = mulberry32(42);
  // Each block's moment: a diagonal sweep, roughened so it reads as pixels and not a line.
  const when = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) when[y * cols + x] = ((x / cols) * 0.55 + (y / rows) * 0.45) * 0.75 + rand() * 0.25;
  const colors = BANDS.map(token);
  const ink = token("--ink"), red = token("--magenta"), cream = token("--on-accent");
  c.classList.add("on");

  return new Promise((resolve) => {
    const t0 = performance.now();
    const draw = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      const p = from + (to - from) * e;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      for (let y = 0; y < rows; y++) {
        // Bands of colour, top to bottom, like the stripes on a 1950s tin.
        ctx.fillStyle = colors[Math.floor((y / rows) * colors.length)]!;
        for (let x = 0; x < cols; x++) {
          const v = when[y * cols + x]!;
          if (v < p) ctx.fillRect(x * BLOCK, y * BLOCK, BLOCK + 0.5, BLOCK + 0.5);
          else if (v < p + 0.05) {
            const s = BLOCK * (1 - (v - p) / 0.05);
            ctx.fillRect(x * BLOCK + (BLOCK - s) / 2, y * BLOCK + (BLOCK - s) / 2, s, s);
          }
        }
      }
      // The ribbon with where you are going, once most of the screen is covered.
      const a = Math.max(0, Math.min(1, (p - 0.7) / 0.25));
      if (a > 0 && label) {
        ctx.globalAlpha = a;
        ctx.font = `400 ${Math.min(64, w / 11)}px "Alfa Slab One", Rockwell, serif`;
        const tw = ctx.measureText(label).width;
        const bw = tw + 120, bh = Math.min(96, w / 7.5);
        const bx = (w - bw) / 2, by = (h - bh) / 2;
        ctx.fillStyle = ink;
        ctx.fillRect(bx + 8, by + 8, bw, bh);
        ctx.fillStyle = red;
        ctx.beginPath();
        ctx.moveTo(bx - 28, by);
        ctx.lineTo(bx + bw + 28, by);
        ctx.lineTo(bx + bw + 6, by + bh / 2);
        ctx.lineTo(bx + bw + 28, by + bh);
        ctx.lineTo(bx - 28, by + bh);
        ctx.lineTo(bx - 6, by + bh / 2);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = cream;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, w / 2, h / 2 + 3);
        ctx.globalAlpha = 1;
      }
      if (k < 1) requestAnimationFrame(draw);
      else {
        if (to <= 0) c.classList.remove("on");
        resolve();
      }
    };
    requestAnimationFrame(draw);
  });
}

/** Fill the screen; resolves when it is covered. */
export const cover = (label: string) => run(label, 0, 1.06, 620);
/** Clear it again. */
export const uncover = (label: string) => run(label, 1.06, -0.06, 680);
