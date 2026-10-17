import { useEffect, useState } from "react";
import { useInView } from "./hooks";

/**
 * Preformatted text that types itself out when it comes into view. The server and
 * reduced motion show all of it; the full text is always what screen readers get.
 */
export function TypeOut({ text, label, cps = 900 }: { text: string; label: string; cps?: number }) {
  const [ref, seen] = useInView<HTMLPreElement>(0.25);
  const [n, setN] = useState(text.length);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setN(0);
  }, []);
  useEffect(() => {
    if (!seen || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      const k = Math.min(text.length, Math.floor(((performance.now() - t0) / 1000) * cps));
      setN(k);
      if (k < text.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [seen, text, cps]);
  return (
    <pre ref={ref} className="typeout" role="img" aria-label={label}>
      <span aria-hidden="true">{text.slice(0, n)}</span>
      <span className="typeout-rest" aria-hidden="true">{text.slice(n)}</span>
    </pre>
  );
}
