// The page's motion, loaded after hydration so it never delays the first paint.
// GSAP for the choreography, Lenis as the one smooth-scroll engine, both torn down by
// the returned cleanup. Hover, press and focus states are CSS and live in styles.css.
// Under prefers-reduced-motion nothing here runs: the final states are the CSS.

const EASE = "0.23,1,0.32,1"; // strong ease-out, the project's one UI curve

export async function initMotion(root: HTMLElement): Promise<() => void> {
  const html = document.documentElement;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    html.classList.remove("motion-pending");
    return () => {};
  }

  const [{ default: gsap }, { ScrollTrigger }, { CustomEase }, { default: Lenis }] = await Promise.all([
    import("gsap"),
    import("gsap/ScrollTrigger"),
    import("gsap/CustomEase"),
    import("lenis"),
  ]);
  gsap.registerPlugin(ScrollTrigger, CustomEase);
  CustomEase.create("mnemoOut", EASE);

  const ctx = gsap.context(() => {
    const intro = gsap.utils.toArray<HTMLElement>("[data-intro]", root);
    const heroWords = gsap.utils.toArray<HTMLElement>("[data-hero] .wi", root);
    const reveals = gsap.utils.toArray<HTMLElement>("[data-reveal]", root);
    const splitHeads = gsap.utils.toArray<HTMLElement>("[data-split]:not([data-hero])", root);

    // Hidden starting states are set here, then the CSS guard comes off in the same
    // frame, so there is no flash and no state the stylesheet has to own.
    // Pages differ in what they have, and GSAP warns about a target that matches nothing.
    if (heroWords.length) gsap.set(heroWords, { yPercent: 108 });
    if (intro.length) gsap.set(intro, { opacity: 0, y: 14 });
    if (reveals.length) gsap.set(reveals, { opacity: 0, y: 16 });
    for (const h of splitHeads) gsap.set(h.querySelectorAll(".wi"), { yPercent: 108 });
    html.classList.remove("motion-pending");

    const tl = gsap.timeline({ defaults: { ease: "mnemoOut" } });
    if (heroWords.length) tl.to(heroWords, { yPercent: 0, duration: 0.75, stagger: 0.04 });
    if (intro.length) tl.to(intro, { opacity: 1, y: 0, duration: 0.55, stagger: 0.07, clearProps: "opacity,transform" }, heroWords.length ? "-=0.45" : 0);

    if (reveals.length) ScrollTrigger.batch(reveals, {
      start: "top 90%",
      once: true,
      onEnter: (els) =>
        gsap.to(els, { opacity: 1, y: 0, duration: 0.55, stagger: 0.06, ease: "mnemoOut", overwrite: true, clearProps: "opacity,transform" }),
    });
    for (const h of splitHeads) {
      ScrollTrigger.create({
        trigger: h,
        start: "top 90%",
        once: true,
        onEnter: () => gsap.to(h.querySelectorAll(".wi"), { yPercent: 0, duration: 0.65, stagger: 0.035, ease: "mnemoOut" }),
      });
    }
  }, root);

  // One smooth-scroll engine, on fine pointers only: touch keeps native momentum.
  let lenis: InstanceType<typeof Lenis> | null = null;
  let tick: ((time: number) => void) | null = null;
  let onAnchor: ((e: MouseEvent) => void) | null = null;
  if (matchMedia("(pointer: fine)").matches) {
    lenis = new Lenis({ lerp: 0.11, smoothWheel: true });
    lenis.on("scroll", ScrollTrigger.update);
    tick = (time) => lenis!.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    onAnchor = (e) => {
      const a = (e.target as Element | null)?.closest<HTMLAnchorElement>('a[href^="#"]');
      const id = a?.getAttribute("href")?.slice(1);
      const el = id ? document.getElementById(id) : null;
      if (!a || !el) return;
      e.preventDefault();
      lenis!.scrollTo(el, { offset: -64, duration: 1.1 });
      history.replaceState(null, "", `#${id}`);
    };
    document.addEventListener("click", onAnchor);
  }

  // Measurements move when fonts and images arrive.
  const refresh = () => ScrollTrigger.refresh();
  window.addEventListener("load", refresh);
  void document.fonts?.ready.then(refresh);

  return () => {
    window.removeEventListener("load", refresh);
    if (onAnchor) document.removeEventListener("click", onAnchor);
    if (tick) gsap.ticker.remove(tick);
    lenis?.destroy();
    ctx.revert();
  };
}
