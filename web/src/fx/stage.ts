// The stage: one WebGL canvas behind every page, kept across page changes.
//
// Mne, the elephant, is built from voxels, one per pixel of the sprite (thicker through
// the head). Every voxel is also a node of a memory graph: it has a home (its place in
// the elephant) and a place in one of the memory's six areas, and `morph` moves it
// between the two. Edges between nodes appear as the graph forms, with recall pulses
// running along them. A second pass can pixelate the scene (the loader hands over a
// pixel elephant) or set it in ASCII. The canvas is transparent: the sunburst behind
// it is the page's own (`.sky` in landing.css), so it never moves or changes hands.
//
// Pages drive it through `state` (GSAP tweens it) and `anchor`: an element whose box
// the elephant sits in, followed exactly every frame, so the 3D scene scrolls with the
// page. A new anchor is reached by an eased move from wherever the elephant is.
import * as THREE from "three";
import { PIXELS } from "./mne";
import { mulberry32 } from "../art/rng";
import { AREA_TOKENS, ELEPHANT_TOKENS, isDark, onTheme, rgb } from "./theme";

export interface StageState {
  /** 0: the elephant. 1: the memory graph. */
  morph: number;
  /** 0..1: how much of the scene is set in ASCII. */
  ascii: number;
  /** Pixel block size in CSS px; 1 is off. */
  pixel: number;
  /** 1 draws flat sprite colours (no light, no outline), to match the loader's pixels. */
  flat: number;
  /** Rotation about the vertical axis, in radians, on top of the pointer's. */
  spin: number;
  tilt: number;
  /** Canvas opacity. */
  fade: number;
  /** An area to pick out (0..5) and how strongly the others dim. */
  area: number;
  areaAmt: number;
  /** How much the graph nodes float about. */
  drift: number;
  /** Zoom on top of the anchor's size. */
  zoom: number;
}

export interface Stage {
  state: StageState;
  /**
   * The element the elephant sits in; null keeps the last box. A different element is
   * reached by an eased move of `ms` (from `from`, or from where the elephant is now),
   * lifted by `arc` CSS px at its middle; `instant` jumps.
   */
  setAnchor(el: Element | null, opts?: { instant?: boolean; ms?: number; from?: Rect; arc?: number }): void;
  /** Places the elephant over a box at once (the loader's handover). */
  snapTo(rect: Rect): void;
  /** Render whatever changed now (reduced motion renders only on demand). */
  invalidate(): void;
  /** Compiles every shader and draws one frame. */
  warm(): Promise<void>;
  destroy(): void;
}

type Rect = { left: number; top: number; width: number; height: number };

const GLYPHS = " .:-=+*#%@";

// Where a node is: between home and its area by its own morph, floating when in the graph.
const NODE_GLSL = /* glsl */ `
uniform float uMorph;
uniform float uTime;
uniform float uDrift;
float morphOf(float seed) {
  float a = seed * 0.45;
  return smoothstep(a, a + 0.55, uMorph);
}
vec3 nodePos(vec3 home, vec3 graph, float seed, float m) {
  vec3 p = mix(home, graph, m);
  // In transit a node arcs outwards instead of sliding in a straight line.
  p += normalize(graph - home + vec3(0.001)) * sin(m * 3.14159) * (2.0 + seed * 3.0) * vec3(1.0, 0.4, 1.0);
  float t = uTime;
  p += m * uDrift * vec3(sin(t * 0.61 + seed * 40.0), cos(t * 0.53 + seed * 23.0), sin(t * 0.47 + seed * 11.0)) * 0.55;
  return p;
}
`;

const VOXEL_VERT = /* glsl */ `
attribute vec3 aHome;
attribute vec3 aGraph;
attribute vec4 aInfo; // seed, sprite colour, area, hub
uniform vec3 uEl[6];
uniform vec3 uAreas[6];
uniform float uArea;
uniform float uAreaAmt;
varying vec3 vColor;
varying vec3 vNormal;
varying vec2 vUv;
varying float vDim;
${NODE_GLSL}
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
void main() {
  float seed = aInfo.x;
  float m = morphOf(seed);
  vec3 c = nodePos(aHome, aGraph, seed, m);
  float spin = sin(m * 3.14159) * (seed - 0.5) * 9.0 + m * uTime * (0.2 + seed * 0.5);
  mat3 R = rotY(spin) * rotX(spin * 0.6);
  float size = mix(0.98, mix(0.62, 1.7, aInfo.w), m);
  vec3 p = R * (position * size) + c;
  vNormal = normalize(normalMatrix * (R * normal));
  vUv = uv;
  int pi = int(aInfo.y + 0.5);
  int ai = int(aInfo.z + 0.5);
  vColor = mix(uEl[pi], uAreas[ai], m);
  vDim = 1.0 - uAreaAmt * m * (abs(aInfo.z - uArea) < 0.5 ? 0.0 : 0.75);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const VOXEL_FRAG = /* glsl */ `
uniform vec3 uInk;
uniform vec3 uBg;
uniform vec3 uLight;
uniform float uFlat;
uniform float uDpr;
varying vec3 vColor;
varying vec3 vNormal;
varying vec2 vUv;
varying float vDim;
void main() {
  float l = dot(normalize(vNormal), normalize(uLight));
  // Three tones, like a print run of three inks.
  float tone = l > 0.5 ? 1.0 : (l > -0.1 ? 0.8 : 0.64);
  vec3 col = vColor * tone;
  // Halftone dots on the shaded faces.
  vec2 g = fract(gl_FragCoord.xy / (4.5 * uDpr)) - 0.5;
  float r = (1.0 - tone) * 1.25;
  float dots = 1.0 - smoothstep(r - 0.06, r, length(g));
  col = mix(col, uInk, dots * 0.22);
  // An inked outline round every face.
  vec2 e = min(vUv, 1.0 - vUv);
  float edge = 1.0 - smoothstep(0.045, 0.085, min(e.x, e.y));
  col = mix(col, uInk, edge * 0.5);
  col = mix(col, vColor, uFlat);
  col = mix(uBg, col, vDim);
  gl_FragColor = vec4(col, 1.0);
}
`;

const EDGE_VERT = /* glsl */ `
attribute vec3 aAH;
attribute vec3 aAG;
attribute vec3 aBH;
attribute vec3 aBG;
attribute vec4 aSeed; // seed a, seed b, edge seed, area
uniform vec2 uRes;
uniform float uWidth;
uniform float uArea;
uniform float uAreaAmt;
varying float vT;
varying float vAlpha;
varying float vSeed;
${NODE_GLSL}
void main() {
  float mA = morphOf(aSeed.x);
  float mB = morphOf(aSeed.y);
  vec3 A = nodePos(aAH, aAG, aSeed.x, mA);
  vec3 B = nodePos(aBH, aBG, aSeed.y, mB);
  vec4 ca = projectionMatrix * modelViewMatrix * vec4(A, 1.0);
  vec4 cb = projectionMatrix * modelViewMatrix * vec4(B, 1.0);
  vec2 sa = ca.xy / ca.w;
  vec2 sb = cb.xy / cb.w;
  vec2 dir = normalize((sb - sa) * uRes + vec2(0.0001));
  vec2 nrm = vec2(-dir.y, dir.x);
  vec4 c = mix(ca, cb, position.x);
  c.xy += nrm * position.y * uWidth / uRes * c.w;
  gl_Position = c;
  vT = position.x;
  float hl = abs(aSeed.w - uArea) < 0.5 ? 1.0 : 1.0 - uAreaAmt * 0.8;
  vAlpha = smoothstep(0.6, 1.0, mA * mB) * hl;
  vSeed = aSeed.z;
}
`;

const EDGE_FRAG = /* glsl */ `
uniform vec3 uLine;
uniform vec3 uPulse;
uniform float uTime;
varying float vT;
varying float vAlpha;
varying float vSeed;
void main() {
  float head = fract(uTime * (0.18 + vSeed * 0.25) + vSeed * 7.0);
  float pulse = exp(-pow((vT - head) * 9.0, 2.0)) * step(0.55, vSeed);
  vec3 col = mix(uLine, uPulse, pulse);
  gl_FragColor = vec4(col, vAlpha * (0.55 + pulse * 0.45));
}
`;

const POST_VERT = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const POST_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tGlyph;
uniform vec2 uRes;
uniform vec2 uOrigin;
uniform float uPixel;
uniform float uAscii;
uniform float uCell;
uniform float uDark;
uniform vec3 uInk;
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 pf = fc;
  if (uPixel > 1.0) pf = (floor((fc - uOrigin) / uPixel) + 0.5) * uPixel + uOrigin;
  // The scene target holds premultiplied colour (blended over transparent black), which
  // is what the transparent canvas wants.
  vec4 col = texture2D(tScene, pf / uRes);

  if (uAscii > 0.001) {
    vec2 cell = floor(fc / uCell);
    vec4 a = texture2D(tScene, (cell + 0.5) * uCell / uRes);
    vec3 ac = a.rgb / max(a.a, 0.001);
    float lum = dot(ac, vec3(0.299, 0.587, 0.114));
    float dens = mix(1.0 - lum, lum, uDark);
    float idx = 1.0 + floor(clamp(dens * 1.25, 0.0, 0.999) * 9.0);
    vec2 lp = fract(fc / uCell);
    float g = texture2D(tGlyph, vec2((idx + lp.x) / 10.0, lp.y)).r * a.a;
    col = mix(col, vec4(mix(ac, uInk, 0.15) * g, g), uAscii);
  }
  gl_FragColor = col;
}
`;

/** Voxels for Mne, front view equal to the sprite: the head and outline go three deep, the ears one. */
function voxels() {
  const out: { home: [number, number, number]; c: number }[] = [];
  for (const p of PIXELS) {
    const x = p.x - 8.5;
    const y = 8.5 - p.y;
    // a eye, b outline, c ear, d hide, e blush, f tusk
    const thick = p.c === 1 || p.c === 3 || p.c === 0;
    const zs = thick ? [-1, 0, 1] : [0];
    for (const z of zs) out.push({ home: [x, y, z], c: p.c === 0 && z !== 1 ? 3 : p.c });
  }
  return out;
}

export async function createStage(canvas: HTMLCanvasElement): Promise<Stage> {
  // The palette is sRGB and the shaders work in it directly: no conversion anywhere.
  THREE.ColorManagement.enabled = false;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: "high-performance" });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  // Phones get fewer pixels: the scene is drawn twice a frame, multisampled.
  const dpr = Math.min(window.devicePixelRatio || 1, matchMedia("(pointer: coarse)").matches ? 1.5 : 1.75);
  renderer.setPixelRatio(dpr);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(16, 1, 1, 1000);
  camera.position.set(0, 0, 220);
  const group = new THREE.Group();
  scene.add(group);

  const state: StageState = { morph: 0, ascii: 0, pixel: 1, flat: 0, spin: 0, tilt: 0, fade: 1, area: 0, areaAmt: 0, drift: 1, zoom: 1 };

  // Nodes ----------------------------------------------------------------------------
  const vox = voxels();
  const n = vox.length;
  const rand = mulberry32(1950);
  const gauss = () => (rand() + rand() + rand() - 1.5) / 1.5;
  const centers: THREE.Vector3[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.4;
    centers.push(new THREE.Vector3(Math.cos(a) * 12.5, Math.sin(a) * 7.5 + (i % 2 ? 2.2 : -2.2), Math.sin(a) * 6));
  }
  const home = new Float32Array(n * 3);
  const graph = new Float32Array(n * 3);
  const info = new Float32Array(n * 4);
  const areaOf: number[] = [];
  const hubOf = new Array<number>(6).fill(-1);
  vox.forEach((v, i) => {
    home.set(v.home, i * 3);
    // Neighbouring pixels go to the same area, so the elephant comes apart in pieces.
    const area = Math.floor(((Math.atan2(v.home[1], v.home[0]) + Math.PI) / (Math.PI * 2)) * 6) % 6;
    areaOf.push(area);
    if (hubOf[area] === -1) hubOf[area] = i;
    const c = centers[area]!;
    const spread = 3.6;
    graph.set([c.x + gauss() * spread, c.y + gauss() * spread * 0.8, c.z + gauss() * spread], i * 3);
    info.set([rand(), v.c, area, 0], i * 4);
  });
  hubOf.forEach((h, area) => {
    const c = centers[area]!;
    graph.set([c.x, c.y, c.z], h * 3);
    info[h * 4 + 3] = 1;
  });

  const box = new THREE.BoxGeometry(1, 1, 1);
  const vg = new THREE.InstancedBufferGeometry();
  vg.index = box.index;
  vg.setAttribute("position", box.getAttribute("position"));
  vg.setAttribute("normal", box.getAttribute("normal"));
  vg.setAttribute("uv", box.getAttribute("uv"));
  vg.setAttribute("aHome", new THREE.InstancedBufferAttribute(home, 3));
  vg.setAttribute("aGraph", new THREE.InstancedBufferAttribute(graph, 3));
  vg.setAttribute("aInfo", new THREE.InstancedBufferAttribute(info, 4));
  vg.instanceCount = n;

  const shared = {
    uMorph: { value: 0 },
    uTime: { value: 0 },
    uDrift: { value: 1 },
    uArea: { value: 0 },
    uAreaAmt: { value: 0 },
    uInk: { value: new THREE.Color() },
    uBg: { value: new THREE.Color() },
  };
  const vmat = new THREE.ShaderMaterial({
    vertexShader: VOXEL_VERT,
    fragmentShader: VOXEL_FRAG,
    uniforms: {
      ...shared,
      uEl: { value: Array.from({ length: 6 }, () => new THREE.Color()) },
      uAreas: { value: Array.from({ length: 6 }, () => new THREE.Color()) },
      uLight: { value: new THREE.Vector3(0.45, 0.8, 0.6) },
      uFlat: { value: 0 },
      uDpr: { value: dpr },
    },
  });
  const voxMesh = new THREE.Mesh(vg, vmat);
  voxMesh.frustumCulled = false;
  group.add(voxMesh);

  // Edges: to the area's hub, to a near neighbour in the same area, and a ring of hubs.
  const pairs: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const area = areaOf[i]!;
    const hub = hubOf[area]!;
    if (i !== hub && rand() < 0.3) pairs.push([i, hub]);
    if (rand() < 0.55) {
      let best = -1;
      let bd = Infinity;
      for (let j = 0; j < n; j++) {
        if (j === i || areaOf[j] !== area) continue;
        const dx = graph[i * 3]! - graph[j * 3]!, dy = graph[i * 3 + 1]! - graph[j * 3 + 1]!, dz = graph[i * 3 + 2]! - graph[j * 3 + 2]!;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bd && rand() < 0.7) [bd, best] = [d, j];
      }
      if (best >= 0) pairs.push([i, best]);
    }
  }
  for (let a = 0; a < 6; a++) {
    pairs.push([hubOf[a]!, hubOf[(a + 1) % 6]!]);
    if (a < 3) pairs.push([hubOf[a]!, hubOf[a + 3]!]);
  }
  const e = pairs.length;
  const aAH = new Float32Array(e * 3), aAG = new Float32Array(e * 3), aBH = new Float32Array(e * 3), aBG = new Float32Array(e * 3);
  const aSeed = new Float32Array(e * 4);
  pairs.forEach(([a, b], k) => {
    aAH.set(home.subarray(a * 3, a * 3 + 3), k * 3);
    aAG.set(graph.subarray(a * 3, a * 3 + 3), k * 3);
    aBH.set(home.subarray(b * 3, b * 3 + 3), k * 3);
    aBG.set(graph.subarray(b * 3, b * 3 + 3), k * 3);
    aSeed.set([info[a * 4]!, info[b * 4]!, rand(), areaOf[a]!], k * 4);
  });
  const eg = new THREE.InstancedBufferGeometry();
  eg.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, -0.5, 0, 1, -0.5, 0, 1, 0.5, 0, 0, 0.5, 0]), 3));
  eg.setIndex([0, 1, 2, 0, 2, 3]);
  eg.setAttribute("aAH", new THREE.InstancedBufferAttribute(aAH, 3));
  eg.setAttribute("aAG", new THREE.InstancedBufferAttribute(aAG, 3));
  eg.setAttribute("aBH", new THREE.InstancedBufferAttribute(aBH, 3));
  eg.setAttribute("aBG", new THREE.InstancedBufferAttribute(aBG, 3));
  eg.setAttribute("aSeed", new THREE.InstancedBufferAttribute(aSeed, 4));
  eg.instanceCount = e;
  const emat = new THREE.ShaderMaterial({
    vertexShader: EDGE_VERT,
    fragmentShader: EDGE_FRAG,
    transparent: true,
    depthWrite: false,
    uniforms: { ...shared, uRes: { value: new THREE.Vector2(1, 1) }, uWidth: { value: 2.2 * dpr }, uPulse: { value: new THREE.Color() }, uLine: { value: new THREE.Color() } },
  });
  const edges = new THREE.Mesh(eg, emat);
  edges.frustumCulled = false;
  edges.renderOrder = 1;
  group.add(edges);

  // The second pass ---------------------------------------------------------------------
  const target = new THREE.WebGLRenderTarget(1, 1, { samples: 4 });
  const glyph = document.createElement("canvas");
  glyph.width = 64 * GLYPHS.length;
  glyph.height = 64;
  const gx = glyph.getContext("2d")!;
  gx.fillStyle = "#000";
  gx.fillRect(0, 0, glyph.width, glyph.height);
  gx.fillStyle = "#fff";
  gx.font = '600 54px "DM Mono", ui-monospace, monospace';
  gx.textAlign = "center";
  gx.textBaseline = "middle";
  [...GLYPHS].forEach((ch, i) => gx.fillText(ch, i * 64 + 32, 34));
  const glyphTex = new THREE.CanvasTexture(glyph);
  glyphTex.flipY = true;

  const post = new THREE.Scene();
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const pmat = new THREE.ShaderMaterial({
    vertexShader: POST_VERT,
    fragmentShader: POST_FRAG,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tScene: { value: target.texture },
      tGlyph: { value: glyphTex },
      uRes: { value: new THREE.Vector2(1, 1) },
      uOrigin: { value: new THREE.Vector2() },
      uPixel: { value: 1 },
      uAscii: { value: 0 },
      uCell: { value: 10 * dpr },
      uDark: { value: 0 },
      uInk: shared.uInk,
    },
  });
  const tri = new THREE.BufferGeometry();
  tri.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const quad = new THREE.Mesh(tri, pmat);
  quad.frustumCulled = false;
  post.add(quad);

  // Colours -----------------------------------------------------------------------------
  const paint = () => {
    const set = (c: THREE.Color, name: string) => c.setRGB(...rgb(name));
    set(shared.uInk.value, "--ink");
    set(shared.uBg.value, "--ground");
    set(emat.uniforms.uPulse!.value, "--magenta");
    set(emat.uniforms.uLine!.value, "--dim");
    ELEPHANT_TOKENS.forEach((t, i) => set(vmat.uniforms.uEl!.value[i], t));
    AREA_TOKENS.forEach((t, i) => set(vmat.uniforms.uAreas!.value[i], t));
    pmat.uniforms.uDark!.value = isDark() ? 1 : 0;
    needs = true;
  };
  let needs = true;
  const stopTheme = onTheme(paint);
  paint();

  // Size and anchor ---------------------------------------------------------------------
  // The canvas is as tall as the largest viewport (100lvh in the CSS), so a phone's
  // toolbar coming and going does not resize it while you scroll.
  let W = 0, H = 0;
  const resize = () => {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    if (w === W && h === H) return;
    W = w;
    H = h;
    renderer.setSize(w, h, false);
    target.setSize(Math.round(w * dpr), Math.round(h * dpr));
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    pmat.uniforms.uRes!.value.set(w * dpr, h * dpr);
    emat.uniforms.uRes!.value.set(w * dpr, h * dpr);
    needs = true;
  };
  resize();

  let anchor: Element | null = null;
  // The box the elephant is in now: centre and height, CSS px.
  const box2 = { x: window.innerWidth / 2, y: window.innerHeight / 2, h: 220 };
  // A move toward a new anchor: from a box, over `ms`, lifted by `arc` at its middle.
  let move: { from: { x: number; y: number; h: number }; t0: number; ms: number; arc: number } | null = null;
  const goal = () => {
    if (!anchor || !anchor.isConnected) return null;
    const r = anchor.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: Math.min(r.width, r.height) };
  };
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  const onPointer = (ev: PointerEvent) => {
    pointer.tx = (ev.clientX / window.innerWidth) * 2 - 1;
    pointer.ty = (ev.clientY / window.innerHeight) * 2 - 1;
  };
  if (!reduced) window.addEventListener("pointermove", onPointer, { passive: true });

  const frame = (t: number) => {
    resize();
    const g = goal();
    if (g && move) {
      const k = Math.min(1, (clock - move.t0) / move.ms);
      const e = ease(k);
      box2.x = move.from.x + (g.x - move.from.x) * e;
      box2.y = move.from.y + (g.y - move.from.y) * e - Math.sin(Math.PI * e) * move.arc;
      box2.h = move.from.h + (g.h - move.from.h) * e;
      if (k >= 1) move = null;
    } else if (g) Object.assign(box2, g);
    pointer.x += (pointer.tx - pointer.x) * 0.05;
    pointer.y += (pointer.ty - pointer.y) * 0.05;

    const visH = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const wpp = visH / H;
    group.position.set((box2.x - W / 2) * wpp, -(box2.y - H / 2) * wpp, 0);
    group.scale.setScalar((box2.h / 18) * wpp * state.zoom);
    const live = 1 - state.flat;
    group.rotation.y = state.spin + pointer.x * 0.45 * live;
    group.rotation.x = state.tilt + pointer.y * 0.25 * live;

    shared.uTime.value = reduced ? 12 : t;
    shared.uMorph.value = state.morph;
    shared.uDrift.value = state.drift;
    shared.uArea.value = state.area;
    shared.uAreaAmt.value = state.areaAmt;
    vmat.uniforms.uFlat!.value = state.flat;
    pmat.uniforms.uPixel!.value = state.pixel * dpr;
    pmat.uniforms.uAscii!.value = state.ascii;
    // Align the pixel grid with the elephant's own grid, so each block is one sprite pixel.
    const cell = (box2.h / 18) * dpr;
    pmat.uniforms.uOrigin!.value.set((box2.x * dpr) - cell * 9, (H - box2.y) * dpr - cell * 9);
    canvas.style.opacity = String(state.fade);

    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(post, postCam);
  };

  let raf = 0;
  let last = { ...state };
  // The stage's own clock, in ms. A frame never advances it by more than about two
  // frames' worth, so when the page stalls (a big layout, a slow phone) a move carries
  // on from where it was instead of skipping ahead to where it should have been.
  let clock = 0;
  let prev = performance.now();
  const loop = () => {
    raf = requestAnimationFrame(loop);
    const now = performance.now();
    clock += Math.min(now - prev, 34);
    prev = now;
    if (document.hidden) return;
    const changed = (Object.keys(state) as (keyof StageState)[]).some((k) => state[k] !== last[k]);
    if (reduced && !needs && !changed) return;
    if (move) needs = true;
    if (state.fade < 0.005 && !changed) return;
    last = { ...state };
    needs = false;
    frame(clock / 1000);
  };
  // Reduced motion still follows the page as it scrolls, without the floating and spinning.
  const onScroll = () => (needs = true);
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  raf = requestAnimationFrame(loop);

  return {
    state,
    setAnchor(el, opts) {
      if (!el) return;
      const changed = el !== anchor || opts?.from;
      anchor = el;
      if (opts?.instant || reduced) move = null;
      else if (changed) {
        const f = opts?.from;
        move = {
          from: f ? { x: f.left + f.width / 2, y: f.top + f.height / 2, h: f.height } : { ...box2 },
          t0: clock,
          ms: opts?.ms ?? 900,
          arc: opts?.arc ?? 0,
        };
      }
      needs = true;
    },
    snapTo(r) {
      anchor = null;
      move = null;
      box2.x = r.left + r.width / 2;
      box2.y = r.top + r.height / 2;
      box2.h = r.height;
      needs = true;
      frame(clock / 1000);
    },
    invalidate() {
      needs = true;
    },
    async warm() {
      renderer.compile(scene, camera);
      renderer.compile(post, postCam);
      frame(0);
    },
    destroy() {
      cancelAnimationFrame(raf);
      stopTheme();
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      target.dispose();
      glyphTex.dispose();
      [vg, eg, tri, box].forEach((x) => x.dispose());
      [vmat, emat, pmat].forEach((x) => x.dispose());
      renderer.dispose();
    },
  };
}
