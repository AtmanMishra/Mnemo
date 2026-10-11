import { useEffect, useState } from "react";
import { Section } from "./Section";

const VIEWS = [
  { key: "g", id: "hub", label: "Hub", img: "hub", w: 1260, h: 844, alt: "The Mnemo hub: a card for each agent with its status, its last prompt and one pixel per turn", cap: "Every agent and what it is doing, one pixel per turn." },
  { key: "s", id: "split", label: "Split", img: "split", w: 1260, h: 826, alt: "Three Mnemo agents side by side in a split view", cap: "Up to four agents side by side." },
  { key: "t", id: "one", label: "One agent", img: "transcript", w: 1080, h: 880, alt: "A single Mnemo agent: the transcript with thinking, tool calls and a diff drawn as pixels", cap: "One agent, full width: thinking, tools and a diff strip." },
] as const;

export function Fleet() {
  const [cur, setCur] = useState(0);
  const [armed, setArmed] = useState(false);

  // While the pointer is over the section, the letters switch views, the way ctrl+g and ctrl+s do in the app.
  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.altKey || (e.target as Element | null)?.closest("input, textarea")) return;
      const i = VIEWS.findIndex((v) => v.key === e.key.toLowerCase());
      if (i >= 0) setCur(i);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armed]);

  return (
    <Section
      id="fleet"
      n="05"
      eyebrow="many agents, one window"
      title="Can I run several agents at once?"
      lead={<>Yes. <kbd>ctrl+n</kbd> starts another agent on this project, <kbd>ctrl+g</kbd> opens the hub, <kbd>ctrl+s</kbd> splits the screen (up to four), <kbd>ctrl+p</kbd> switches project, and a toast tells you when one you are not watching finishes or needs you.</>}
    >
      <div className="fleet" data-reveal="" onPointerEnter={() => setArmed(true)} onPointerLeave={() => setArmed(false)}>
        <div className="fleet-keys" role="tablist" aria-label="View">
          {VIEWS.map((v, i) => (
            <button key={v.id} type="button" role="tab" aria-selected={i === cur} onClick={() => setCur(i)}>
              {v.key === "t" ? null : <kbd>ctrl+{v.key}</kbd>}{v.label}
            </button>
          ))}
        </div>
        <div className="fleet-stage">
          {VIEWS.map((v, i) => (
            <figure key={v.id} className={i === cur ? "shot on" : "shot"} aria-hidden={i === cur ? undefined : true}>
              <picture>
                <source srcSet={`/img/${v.img}.webp`} type="image/webp" />
                <img src={`/img/${v.img}.png`} alt={v.alt} width={v.w} height={v.h} loading="lazy" decoding="async" />
              </picture>
            </figure>
          ))}
        </div>
        <p className="fleet-cap" aria-live="polite">{VIEWS[cur]!.cap} <span className="mut">Hover here and press g, s or t.</span></p>
      </div>
    </Section>
  );
}
