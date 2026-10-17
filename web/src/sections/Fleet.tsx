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
      n="06"
      eyebrow="many agents, one window"
      title="Can I run several agents at once?"
      lead={<>Yes, and they can work as a team. <kbd>ctrl+n</kbd> starts another agent on this project, <kbd>ctrl+g</kbd> opens the hub, <kbd>ctrl+s</kbd> splits the screen (up to four), <kbd>ctrl+p</kbd> switches project, and a toast tells you when one you are not watching finishes or needs you. Link two agents and they message each other on their own, within limits you can see.</>}
      figure={{ name: "hub", label: "A hub with eight tiles around it on dashed links; the tile under the pointer rises and its link turns solid", means: "One hub, many agents: the one you point at comes forward, the rest keep working." }}
      how={[
        { t: "Another agent, same project", d: <><kbd>ctrl+n</kbd> starts another agent on this project, with its own session. Agents on the same project share one memory, so what one learns, the others recall.</> },
        { t: "The hub", d: <><kbd>ctrl+g</kbd> shows a card per agent: its status, its last prompt, and one pixel per turn, so a glance says which one is busy, idle or waiting on you.</> },
        { t: "Split view", d: <><kbd>ctrl+s</kbd> puts up to four agents side by side, each with its own transcript and prompt, in columns, rows, a grid or main + side (<kbd>alt+l</kbd>). A sub-agent that starts while its agent is on screen takes a pane by itself.</> },
        { t: "Sub-agents, and agents that talk", d: <>An agent can start sub-agents, and they can start their own, three levels deep. Press <kbd>l</kbd> on two cards in the hub to link them as siblings: they see what the other is doing and message each other. A message wakes an idle agent, which reads it and can answer on its own, and the conversation marks it ✉ as another agent's words, not yours. Links are remembered, so two projects you linked are linked again when both are open.</> },
        { t: "Talk to a sub-agent", d: <>In a split, <kbd>alt+,</kbd> and <kbd>alt+.</kbd> move through every pane, sub-agents included. A focused sub-agent pane has a prompt: what you type reaches it after its current step, as your words. <kbd>esc</kbd> goes back to the agent.</> },
        { t: "Bounded on its own", d: <>Agents answering each other stop after 12 messages in a row since you last spoke, and turns that messages start may spend $0.50 per agent until you prompt it again. Past either, messages wait for you, and the hub card says so. A woken agent's edits and commands still ask you, as any turn does.</> },
        { t: "The playground", d: <><kbd>ctrl+y</kbd> shows every agent, sub-agent and message between them, live, to watch only. <kbd>c</kbd> shows the selected agent's exchange with another as a thread, and <kbd>enter</kbd> takes you to the agent.</> },
        { t: "Projects", d: <><kbd>ctrl+p</kbd> switches project. Memory is kept per project, so a command learned in one repository is not offered in another.</> },
        { t: "Toasts", d: <>When an agent you are not watching finishes or needs an answer, a toast says which one, so a long run never waits on you unnoticed.</> },
      ]}
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
