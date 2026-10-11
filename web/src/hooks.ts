import { useEffect, useRef, useState, type RefObject } from "react";

/** False on the server and under prefers-reduced-motion; true once mounted otherwise. */
export function useMotionOK(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => setOk(!matchMedia("(prefers-reduced-motion: reduce)").matches), []);
  return ok;
}

/** Becomes true once the element is mostly on screen, and stays true. */
export function useInView<T extends Element>(threshold = 0.35): [RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && setSeen(true), { threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [seen, threshold]);
  return [ref, seen];
}

/**
 * A sequence that plays when it comes into view: `step` counts up to `total` every
 * `ms`. Server render and reduced motion get the finished state, so the content is
 * always there without JavaScript; `replay` starts it again.
 */
export function useSequence<T extends Element>(total: number, ms: number): { ref: RefObject<T>; step: number; replay: () => void; playing: boolean } {
  const [ref, seen] = useInView<T>();
  const motion = useMotionOK();
  const [step, setStep] = useState(total);
  const [run, setRun] = useState(0);
  useEffect(() => {
    if (motion) setStep(0);
  }, [motion]);
  useEffect(() => {
    if (!motion || !seen) return;
    setStep(0);
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setStep(i);
      if (i >= total) clearInterval(id);
    }, ms);
    return () => clearInterval(id);
  }, [motion, seen, run, total, ms]);
  return { ref, step, replay: () => setRun((r) => r + 1), playing: motion && step < total };
}
