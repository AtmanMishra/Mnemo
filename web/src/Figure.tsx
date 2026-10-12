import { useEffect, useRef, useState } from "react";

// One Hairline figure (@lucasmarkes/hairline): an isometric line drawing that answers
// the pointer. Loaded only when it nears the screen, so the library costs nothing
// until then; on the server and before that it is an empty 5:4 box, so nothing
// shifts. `play` walks it through its answer until a pointer or focus arrives.
export type FigureName =
  | "terminal" | "settle" | "sieve" | "riffle" | "format" | "hub" | "vault"
  | "relay" | "patch" | "keyboard" | "exploded" | "query" | "laptop" | "branches";

export function Figure({ name, label, means, intensity = 0.5 }: { name: FigureName; label: string; means: string; intensity?: number }) {
  const stage = useRef<HTMLDivElement>(null);
  const [read, setRead] = useState("");

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    let cancelled = false;
    let fig: { destroy(): void } | undefined;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e?.isIntersecting) return;
        io.disconnect();
        void import("@lucasmarkes/hairline").then((hl) => {
          if (cancelled) return;
          const make = hl[name] as (node: HTMLElement, opts: Record<string, unknown>) => { destroy(): void };
          fig = make(el, { intensity, label, play: true, onRead: setRead });
        });
      },
      { rootMargin: "240px" },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
      fig?.destroy();
    };
  }, [name, label, intensity]);

  return (
    <figure className="hl" data-reveal="">
      <div ref={stage} className="hl-stage" role="img" aria-label={label} />
      <figcaption>
        <span className="hl-name">{name}</span>
        <span className="hl-read" aria-live="off">{read}</span>
        <span className="hl-means">{means}</span>
      </figcaption>
    </figure>
  );
}
