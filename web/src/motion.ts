// The page's motion, loaded after hydration so it never delays the first paint.
// GSAP for the choreography, Lenis as the one smooth-scroll engine. `initMotion` runs
// once per visit; `pageMotion` runs for every page (the first, and each one the router
// swaps in) and returns its cleanup. Under prefers-reduced-motion nothing moves: the
// final states are the CSS, and the stage is set per page without tweens.
import type { Stage } from "./fx/stage";
import { finished } from "./fx/boot";
import { stageReady } from "./fx/host";

const EASE = "0.23,1,0.32,1"; // strong ease-out, the project's one UI curve

type GSAP = typeof import("gsap").default;
type ST = typeof import("gsap/ScrollTrigger").ScrollTrigger;
type LenisT = InstanceType<typeof import("lenis").default>;

let engine: Promise<{ gsap: GSAP; ScrollTrigger: ST; lenis: LenisT | null }> | null = null;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function initMotion() {
  engine ??= (async () => {
    const [{ default: gsap }, { ScrollTrigger }, { CustomEase }, { default: Lenis }] = await Promise.all([
      import("gsap"),
      import("gsap/ScrollTrigger"),
      import("gsap/CustomEase"),
      import("lenis"),
    ]);
    gsap.registerPlugin(ScrollTrigger, CustomEase);
    CustomEase.create("mnemoOut", EASE);
    let lenis: LenisT | null = null;
    // One smooth-scroll engine, on fine pointers only: touch keeps native momentum.
    if (!reduced() && matchMedia("(pointer: fine)").matches) {
      lenis = new Lenis({ lerp: 0.1, smoothWheel: true });
      lenis.on("scroll", ScrollTrigger.update);
      gsap.ticker.add((time) => lenis!.raf(time * 1000));
      document.addEventListener("click", (e) => {
        const a = (e.target as Element | null)?.closest<HTMLAnchorElement>('a[href^="#"]');
        const id = a?.getAttribute("href")?.slice(1);
        const el = id ? document.getElementById(id) : null;
        if (!a || !el) return;
        e.preventDefault();
        lenis!.scrollTo(el, { offset: -80, duration: 1.1 });
        history.replaceState(history.state, "", `#${id}`);
      });
    }
    const refresh = () => ScrollTrigger.refresh();
    window.addEventListener("load", refresh);
    void document.fonts?.ready.then(refresh);
    return { gsap, ScrollTrigger, lenis };
  })();
  return engine;
}

/** Jump to the top (or to `hash`) after a page change, without smoothing. */
export async function jumpTo(hash: string) {
  const { lenis, ScrollTrigger } = await initMotion();
  const el = hash ? document.getElementById(hash.slice(1)) : null;
  const y = el ? el.getBoundingClientRect().top + window.scrollY - 80 : 0;
  if (lenis) lenis.scrollTo(y, { immediate: true, force: true });
  else window.scrollTo(0, y);
  ScrollTrigger.refresh();
}

let resolveSet: (() => void) | null = null;
/** Resolves when the newest page has its starting states set (so the wipe can lift). */
export function pageSet(): Promise<void> {
  return new Promise((r) => {
    resolveSet = r;
    setTimeout(r, 1200);
  });
}

export async function pageMotion(root: HTMLElement): Promise<() => void> {
  const html = document.documentElement;
  const { gsap, ScrollTrigger } = await initMotion();
  const stage = await stageReady;
  if (reduced()) {
    html.classList.remove("motion-pending");
    resolveSet?.();
    return () => {};
  }

  let tl: gsap.core.Timeline | null = null;
  const ctx = gsap.context(() => {
    const intro = gsap.utils.toArray<HTMLElement>("[data-intro]", root);
    const heroWords = gsap.utils.toArray<HTMLElement>("[data-hero] .wi", root);
    const reveals = gsap.utils.toArray<HTMLElement>("[data-reveal]", root);
    const splitHeads = gsap.utils.toArray<HTMLElement>("[data-split]:not([data-hero])", root);
    const stamps = gsap.utils.toArray<HTMLElement>("[data-stamp]", root);

    // Hidden starting states are set here, then the CSS guard comes off in the same
    // frame, so there is no flash and no state the stylesheet has to own.
    if (heroWords.length) gsap.set(heroWords, { yPercent: 110, rotate: 4 });
    if (intro.length) gsap.set(intro, { opacity: 0, y: 18 });
    if (stamps.length) gsap.set(stamps, { opacity: 0, scale: 1.6, rotate: -25 });
    if (reveals.length) gsap.set(reveals, { opacity: 0, y: 26 });
    for (const h of splitHeads) gsap.set(h.querySelectorAll(".wi"), { yPercent: 110 });
    html.classList.remove("motion-pending");
    resolveSet?.();

    tl = gsap.timeline({ paused: true, defaults: { ease: "mnemoOut" } });
    if (stamps.length) tl.to(stamps, { opacity: 1, scale: 1, rotate: -8, duration: 0.7, ease: "back.out(2.2)", stagger: 0.1 }, 0);
    if (heroWords.length) tl.to(heroWords, { yPercent: 0, rotate: 0, duration: 0.9, stagger: 0.05 }, 0.1);
    if (intro.length) tl.to(intro, { opacity: 1, y: 0, duration: 0.6, stagger: 0.08, clearProps: "opacity,transform" }, heroWords.length ? 0.45 : 0.1);

    if (reveals.length) ScrollTrigger.batch(reveals, {
      start: "top 90%",
      once: true,
      onEnter: (els) => gsap.to(els, { opacity: 1, y: 0, duration: 0.7, stagger: 0.07, ease: "mnemoOut", overwrite: true, clearProps: "opacity,transform" }),
    });
    for (const h of splitHeads) {
      ScrollTrigger.create({
        trigger: h,
        start: "top 90%",
        once: true,
        onEnter: () => gsap.to(h.querySelectorAll(".wi"), { yPercent: 0, duration: 0.75, stagger: 0.04, ease: "mnemoOut" }),
      });
    }

    // Ribbons of words that run sideways, faster and leaning while you scroll.
    for (const m of gsap.utils.toArray<HTMLElement>("[data-marquee]", root)) {
      const track = m.querySelector<HTMLElement>(".mq-track");
      if (!track) continue;
      const dir = m.dataset.marquee === "rev" ? 1 : -1;
      const loop = gsap.fromTo(track, { xPercent: dir < 0 ? 0 : -50 }, { xPercent: dir < 0 ? -50 : 0, duration: 28, ease: "none", repeat: -1 });
      const skew = gsap.quickTo(track, "skewX", { duration: 0.5, ease: "power3" });
      ScrollTrigger.create({
        trigger: m,
        onUpdate: (self) => {
          const v = self.getVelocity();
          loop.timeScale(1 + Math.min(4, Math.abs(v) / 400));
          skew(gsap.utils.clamp(-12, 12, v / -120));
        },
      });
    }

    // Things that drift at their own speed as the page scrolls past.
    for (const el of gsap.utils.toArray<HTMLElement>("[data-speed]", root)) {
      const s = parseFloat(el.dataset.speed || "0");
      gsap.fromTo(el, { y: () => s * -120 }, { y: () => s * 120, ease: "none", scrollTrigger: { trigger: el, start: "top bottom", end: "bottom top", scrub: true } });
    }

    // Numbers that count up when they arrive.
    for (const el of gsap.utils.toArray<HTMLElement>("[data-count]", root)) {
      const to = parseFloat(el.dataset.count || "0");
      const o = { v: 0 };
      el.textContent = "0";
      ScrollTrigger.create({
        trigger: el,
        start: "top 92%",
        once: true,
        onEnter: () => gsap.to(o, { v: to, duration: 1.4, ease: "power2.out", onUpdate: () => (el.textContent = String(Math.round(o.v))) }),
      });
    }

    if (stage) scenes(root, gsap, ScrollTrigger, stage);
  }, root);

  // The hero waits for the loader to lift; a page the router swapped in starts at once.
  void finished.then(() => tl?.play());

  // Pins made by sections (the demo) and by the scenes arrive in any order; sort them by
  // position so each one measures with the pins above it in place.
  ScrollTrigger.sort();
  ScrollTrigger.refresh();
  return () => ctx.revert();
}

/** Scroll-driven scenes that move the stage: the home story and the six areas. */
function scenes(root: HTMLElement, gsap: GSAP, ScrollTrigger: ST, stage: Stage) {
  const s = stage.state;

  // Home: the elephant comes apart into the memory graph, is written down as text, and
  // comes back together, all on the scroll.
  const story = root.querySelector<HTMLElement>("[data-scene='story']");
  if (story) {
    const anchor = story.querySelector("[data-story-anchor]");
    const heroAnchor = root.querySelector("[data-stage-anchor]");
    ScrollTrigger.create({
      trigger: story,
      start: "top 60%",
      end: "bottom 40%",
      onToggle: (self) => stage.setAnchor(self.isActive ? anchor : self.direction < 0 ? heroAnchor : anchor),
    });
    const tl = gsap.timeline({ scrollTrigger: { trigger: story, start: "top bottom", end: "bottom bottom", scrub: 1.2 } });
    tl.fromTo(s, { spin: -0.5, zoom: 1, morph: 0, ascii: 0, tilt: 0 }, { spin: 0.6, zoom: 1.05, duration: 1, immediateRender: false })
      .to(s, { morph: 1, spin: 2.2, tilt: 0.25, zoom: 0.8, duration: 2 })
      .to(s, { ascii: 1, spin: 2.8, duration: 1.4 })
      .to(s, { ascii: 0, duration: 0.8 })
      .to(s, { morph: 0, spin: Math.PI * 2 - 0.5, tilt: 0, zoom: 1, duration: 2 });
    for (const beat of gsap.utils.toArray<HTMLElement>(".beat-card", story)) {
      gsap.fromTo(beat, { opacity: 0, y: 60, rotate: beat.dataset.side === "r" ? 3 : -3 }, {
        opacity: 1, y: 0, rotate: 0, ease: "mnemoOut",
        scrollTrigger: { trigger: beat, start: "top 85%", end: "top 45%", scrub: 0.6 },
      });
    }
    // Past the story the elephant settles back into the hero's spot, small and quiet.
    const after = root.querySelector("[data-after-story]");
    if (after) gsap.fromTo(s, { fade: 1 }, { fade: 0.35, ease: "none", immediateRender: false, scrollTrigger: { trigger: after, start: "top 80%", end: "top 20%", scrub: true } });
  }

  // How it works: scrolling through the six areas lights each one in the graph.
  const areas = root.querySelector<HTMLElement>("[data-scene='areas']");
  if (areas) {
    const items = gsap.utils.toArray<HTMLElement>("[data-area]", areas);
    const anchor = areas.querySelector("[data-areas-anchor]");
    const back = root.querySelector("[data-stage-anchor]");
    ScrollTrigger.create({
      trigger: areas,
      start: "top 55%",
      end: "bottom 45%",
      onToggle: (self) => {
        stage.setAnchor(self.isActive ? anchor : back);
        gsap.to(s, { areaAmt: self.isActive ? 1 : 0, zoom: self.isActive ? 0.72 : 0.62, fade: self.isActive ? 1 : 0.25, duration: 0.6 });
      },
    });
    for (const it of items) {
      ScrollTrigger.create({
        trigger: it,
        start: "top 55%",
        end: "bottom 55%",
        onToggle: (self) => {
          it.classList.toggle("on", self.isActive);
          if (self.isActive) gsap.to(s, { area: Number(it.dataset.area), spin: s.spin + 0.6, duration: 0.7, ease: "power3.out" });
        },
      });
    }
  }

  // Inner pages: the graph is the page head's picture, and fades back behind the text.
  const head = root.querySelector(".pagehead");
  if (head) gsap.fromTo(s, { fade: 0.9 }, { fade: 0.25, ease: "none", immediateRender: false, scrollTrigger: { trigger: head, start: "bottom 75%", end: "bottom 10%", scrub: true } });

  // Features: a reel of cards that slides sideways as you scroll down.
  const reel = root.querySelector<HTMLElement>("[data-scene='reel']");
  const track = reel?.querySelector<HTMLElement>(".reel-track");
  if (reel && track && matchMedia("(min-width: 900px)").matches) {
    gsap.to(track, {
      x: () => -(track.scrollWidth - reel.clientWidth),
      ease: "none",
      scrollTrigger: { trigger: reel, start: "center center", end: () => `+=${track.scrollWidth - reel.clientWidth}`, pin: true, scrub: 0.8, invalidateOnRefresh: true, refreshPriority: 1 },
    });
    gsap.to(s, { spin: s.spin + 3, ease: "none", scrollTrigger: { trigger: reel, start: "top top", end: "bottom top", scrub: true } });
  }
}
