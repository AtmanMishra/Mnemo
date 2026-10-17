// The one stage for the whole visit: mounted once by the Shell, reconfigured per page.
import type { Stage } from "./stage";
import { complete, finished, isBooting, onHandoff } from "./boot";

let stage: Stage | null = null;
let resolveReady!: (s: Stage | null) => void;
export const stageReady = new Promise<Stage | null>((r) => (resolveReady = r));
export const getStage = () => stage;

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function webgl(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl2");
  } catch {
    return false;
  }
}

function giveUp() {
  document.documentElement.classList.add("no-webgl");
  complete("three.js");
  complete("memory graph");
  complete("shaders");
  resolveReady(null);
}

let mounting = false;
export async function mountStage(canvas: HTMLCanvasElement) {
  if (mounting) return;
  mounting = true;
  if (!webgl()) return giveUp();
  try {
    const mod = await import("./stage");
    complete("three.js");
    stage = await mod.createStage(canvas);
    complete("memory graph");
    await stage.warm();
    complete("shaders");
  } catch (err) {
    console.warn("mnemo: the 3D stage is off", err);
    stage = null;
    return giveUp();
  }
  const s = stage;
  document.documentElement.classList.add("has-stage");
  onHandoff((rect) => {
    // The same picture as the loader's: flat colours, one block per sprite pixel.
    Object.assign(s.state, { flat: 1, pixel: rect.height / 18, morph: 0, spin: 0, tilt: 0, ascii: 0, fade: 1, rays: 1, zoom: 1 });
    s.snapTo(rect);
  });
  resolveReady(s);
}

const anchorEl = () => document.querySelector("[data-stage-anchor]");
// The page's own look is one tween at a time; the page's scroll scenes tween the same
// state and must not be killed with it.
let look: { kill(): void } | null = null;

/**
 * Point the stage at this page. Home is the elephant; every other page is the memory
 * graph, floating in the page head. After the loader the elephant first comes to life
 * where the loader left it (unpixelates, turns round), then goes to its place.
 */
export async function stagePage(path: string) {
  const s = await stageReady;
  if (!s) return;
  const { default: gsap } = await import("gsap");
  const home = path === "/";
  const to = { morph: home ? 0 : 1, fade: home ? 1 : 0.9, rays: home ? 1 : 0.75, ascii: 0, areaAmt: 0, zoom: home ? 1 : 0.62, tilt: 0, drift: 1 };
  look?.kill();
  if (reduced()) {
    Object.assign(s.state, to, { pixel: 1, flat: 0, spin: home ? -0.5 : 0.4 });
    s.setAnchor(anchorEl(), { instant: true });
    return;
  }
  if (isBooting()) {
    await finished;
    const tl = gsap.timeline();
    look = tl;
    tl.to(s.state, { pixel: 1, duration: 0.7, ease: "steps(6)" });
    tl.to(s.state, { flat: 0, duration: 0.5, ease: "power2.out" }, "<0.35");
    tl.to(s.state, { spin: Math.PI * 2 - 0.5, duration: 1.8, ease: "power3.inOut" }, "<");
    tl.add(() => s.setAnchor(anchorEl()), "<0.6");
    tl.to(s.state, { ...to, duration: 1.6, ease: "power3.inOut" }, "<");
    return;
  }
  s.setAnchor(anchorEl());
  look = gsap.to(s.state, { ...to, spin: home ? -0.5 : s.state.spin + 0.9, pixel: 1, flat: 0, duration: 1.4, ease: "power3.inOut" });
}
