import { useEffect, useRef, useState, type ReactNode } from "react";
import { HowItWorks, Term } from "./Section";
import { Split } from "../Split";

// The turn `mnemo --demo` plays, line for line from app/src/runtime/demo.ts: the
// same prompt, thinking, tool calls, diff, answer and what reflection keeps.
const PROMPT = "add a retry to the fetch helper";

interface Beat {
  label: string;
  body: string;
  lines: ReactNode;
}

const BEATS: Beat[] = [
  {
    label: "You ask",
    body: "One line, in the folder you are working in.",
    lines: null, // the prompt is typed, see below
  },
  {
    label: "It thinks, then reads first",
    body: "Memory is searched before the model is asked anything. Then it looks at the file before it changes it.",
    lines: (
      <>
        <div className="ln think"><b>·</b>The user wants retries on the fetch helper. I should read it first to see how errors surface, then retry only on server errors so a 404 still fails fast.</div>
        <div className="ln agent"><b>│</b>I'll look at the helper first.</div>
        <div className="ln tool"><b>●</b>read <span className="path">src/fetch.ts</span> <span className="mut">5 lines</span></div>
      </>
    ),
  },
  {
    label: "It edits, and asks first",
    body: "Every edit and command waits for you by default. The change is shown as a diff.",
    lines: (
      <>
        <div className="ln tool"><b>●</b>edit <span className="path">src/fetch.ts</span> <span className="ask">asks first</span></div>
        <pre className="diff">
          <span className="del">-  const res = await fetch(url);</span>
          <span className="del">-  if (!res.ok) throw new Error(`HTTP ${"${res.status}"}`);</span>
          <span className="del">-  return res.json();</span>
          <span className="add">+  for (let attempt = 1; ; attempt++) {"{"}</span>
          <span className="add">+    const res = await fetch(url);</span>
          <span className="add">+    if (res.ok) return res.json();</span>
          <span className="add">+    if (attempt === 3 || res.status &lt; 500) throw …</span>
          <span className="add">+    await new Promise((r) =&gt; setTimeout(r, 200 * 2 ** attempt));</span>
          <span className="add">+  {"}"}</span>
        </pre>
      </>
    ),
  },
  {
    label: "It checks its work",
    body: "A change is checked before it is called done. A run that changed code and ran nothing is sent back.",
    lines: (
      <>
        <div className="ln agent"><b>│</b>Checking the change.</div>
        <div className="ln tool"><b>●</b>bash <span className="path">git diff --check &amp;&amp; git diff --stat</span></div>
        <div className="ln out">src/fetch.ts | 9 <span className="g">++++++</span><span className="r">---</span></div>
      </>
    ),
  },
  {
    label: "It answers",
    body: "Plain words about what changed and why.",
    lines: (
      <div className="ln agent"><b>│</b><span>Done — <code>getJson</code> now retries <strong>server errors</strong> up to three times: <code>5xx</code> responses back off exponentially (400 ms, 800 ms); <code>4xx</code> responses still fail on the first try.</span></div>
    ),
  },
  {
    label: "It remembers",
    body: "After the run, what it learned is written down for next time: facts, what was decided, what is still open.",
    lines: (
      <div className="learned">
        <div className="ln mem"><b>◆</b>+2 learned</div>
        <div className="fact"><span>language</span>TypeScript</div>
        <div className="fact"><span>http helper</span>getJson (src/fetch.ts) retries 5xx up to 3 times with backoff; 4xx fail fast</div>
        <div className="fact open"><span>open</span>no test covers the retry path yet</div>
      </div>
    ),
  },
];

export function DemoScroll() {
  const section = useRef<HTMLElement>(null);
  const pin = useRef<HTMLDivElement>(null);
  // Position along the beats, 0..BEATS.length. The server and reduced motion show it all.
  const [pos, setPos] = useState(BEATS.length);

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let cleanup = () => {};
    let cancelled = false;
    setPos(0);
    if (matchMedia("(min-width: 900px)").matches) {
      // Desktop: the section pins and scrolling scrubs through the turn.
      void Promise.all([import("gsap"), import("gsap/ScrollTrigger")]).then(([{ default: gsap }, { ScrollTrigger }]) => {
        if (cancelled || !section.current || !pin.current) return;
        gsap.registerPlugin(ScrollTrigger);
        let last = -1;
        const st = ScrollTrigger.create({
          trigger: section.current,
          start: "top top",
          end: () => `+=${window.innerHeight * 2.4}`,
          pin: pin.current,
          scrub: true,
          onUpdate: (self) => {
            const next = Math.round(self.progress * BEATS.length * 20) / 20;
            if (next !== last) setPos((last = next));
          },
        });
        // The pin adds scroll length; triggers below it measured before it existed.
        ScrollTrigger.refresh();
        cleanup = () => st.kill();
      });
    } else {
      // Touch and small screens: it plays once when it comes into view.
      const io = new IntersectionObserver(([e]) => {
        if (!e?.isIntersecting) return;
        io.disconnect();
        let p = 0;
        const id = setInterval(() => {
          p = Math.min(BEATS.length, p + 0.25);
          setPos(p);
          if (p >= BEATS.length) clearInterval(id);
        }, 260);
        cleanup = () => clearInterval(id);
      }, { threshold: 0.3 });
      if (section.current) io.observe(section.current);
      cleanup = () => io.disconnect();
    }
    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  const active = Math.min(BEATS.length - 1, Math.floor(pos));
  const typed = PROMPT.slice(0, Math.round(Math.min(1, pos * 1.6) * PROMPT.length));

  return (
    <section ref={section} className="demo" id="demo" aria-labelledby="demo-h">
      <div ref={pin} className="demo-pin">
        <div className="demo-copy">
          <p className="eyebrow"><span>01</span> one turn, start to finish</p>
          <Split id="demo-h" text="What does a turn with Mnemo look like?" />
          <ol className="beats">
            {BEATS.map((b, i) => (
              <li key={b.label} className={i === active ? "on" : i < pos ? "done" : ""}>
                <strong>{b.label}</strong>
                <span>{b.body}</span>
              </li>
            ))}
          </ol>
          <p className="hint" aria-hidden="true">This is the turn <code>mnemo --demo</code> plays. Scroll to step through it.</p>
        </div>
        <Term title="mnemo — mnemo-demo" className="demo-term">
          <div className="ln you"><b>▊</b>{typed}<span className={typed.length < PROMPT.length ? "caret" : "caret off"} /></div>
          {BEATS.slice(1).map((b, i) => (
            <div key={b.label} className={pos > i + 1 ? "beat in" : "beat"} aria-hidden={pos > i + 1 ? undefined : true}>
              {b.lines}
            </div>
          ))}
          <div className="term-status" aria-hidden="true">
            <span className="mode">default · asks before edits and commands</span>
            <span>demo-model</span>
          </div>
        </Term>
      </div>
      <div className="wrap">
        <HowItWorks
          title="One turn, end to end"
          items={[
            { t: "Memory first", d: <>Before the model sees your message, memory is searched for it and what it finds is attached: facts about the project and you, earlier sessions, pitfalls with their fixes, skills. Recalled items are candidates, never presented as fact.</> },
            { t: "The model streams", d: <>Thinking, text and tool calls stream into the transcript as they arrive. <kbd>enter</kbd> while it works queues your next message, <kbd>alt+enter</kbd> adds a newline, and <kbd>esc</kbd> interrupts the turn.</> },
            { t: "Every tool call passes the gate", d: <>Reads run. Edits and commands ask, unless your mode or rules say otherwise, and a deny rule always holds. The question names the command or the file it is about.</> },
            { t: "Everything is logged into the session", d: <>Each tool call and its outcome is recorded with its subject. A failure steers memory right away, once per distinct failure, so the same mistake is less likely in the same run.</> },
            { t: "After the run, reflection", d: <>A clean run reinforces the memories that fed it. Then one grounded reflection writes the session record, the facts you stated or a tool showed, the fixes that resolved failures, and a skill when one was demonstrated.</> },
          ]}
        />
      </div>
    </section>
  );
}
