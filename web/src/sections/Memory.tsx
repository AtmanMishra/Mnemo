import { useMemo, useState, type FormEvent } from "react";
import { Section, Term } from "./Section";

type Kind = "fact" | "pitfall" | "open" | "skill" | "session";
interface Node {
  id: string;
  kind: Kind;
  key: string;
  value: string;
  trust: number;
  retired?: boolean;
  fresh?: boolean;
  /** Whether a session about the retry would recall it. */
  retry?: boolean;
}

// What the demo turn left behind, plus what a project collects over a few more sessions.
// The first three are exactly what `mnemo --demo` writes; the rest are examples.
const START: Node[] = [
  { id: "lang", kind: "fact", key: "language", value: "TypeScript", trust: 1, retry: true },
  { id: "http", kind: "fact", key: "http helper", value: "getJson (src/fetch.ts) retries 5xx up to 3 times with backoff; 4xx fail fast", trust: 1, retry: true },
  { id: "open", kind: "open", key: "open thread", value: "no test covers the retry path yet", trust: 1, retry: true },
  { id: "pm", kind: "fact", key: "package manager", value: "pnpm, not npm", trust: 1 },
  { id: "pit", kind: "pitfall", key: "pitfall → fix", value: "tests hang on the dev server port → run them with --runInBand", trust: 1, retry: true },
  { id: "skill", kind: "skill", key: "skill", value: "run-checks: typecheck, then tests, before calling a change done", trust: 1, retry: true },
  { id: "s1", kind: "session", key: "session", value: "add a retry to the fetch helper · done", trust: 1 },
];

const LABELS: Record<Kind, string> = { fact: "fact", pitfall: "pitfall", open: "open thread", skill: "skill", session: "session" };

function place(i: number, n: number) {
  const a = (i / n) * Math.PI * 2 - Math.PI / 2;
  const r = i % 2 ? 150 : 128;
  return { x: 280 + Math.cos(a) * r * 1.35, y: 200 + Math.sin(a) * r };
}

export function Memory() {
  const [nodes, setNodes] = useState<Node[]>(START);
  const [sel, setSel] = useState("http");
  const [draft, setDraft] = useState("");
  const selected = nodes.find((n) => n.id === sel);
  const recalled = useMemo(() => nodes.filter((n) => n.retry && !n.retired && n.trust > 0.4), [nodes]);

  const update = (id: string, f: (n: Node) => Node) => setNodes((all) => all.map((n) => (n.id === id ? f(n) : n)));
  const remember = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    const id = `u${Date.now()}`;
    setNodes((all) => [...all.slice(0, 11), { id, kind: "fact", key: "you said", value: text, trust: 1, fresh: true }]);
    setSel(id);
    setDraft("");
  };

  return (
    <Section
      id="memory"
      n="02"
      eyebrow="memory"
      title="What does Mnemo remember, and how do I control it?"
      lead={<>Facts, conventions, pitfalls with their fixes, open threads and skills, stored on your machine and kept per project. Before every model call the relevant ones are recalled; you can read all of it with <code>/memory</code>, add with <code>/remember</code> and retire with <code>/forget</code>. Try it: select a node, steer it, forget it, or tell it something.</>}
    >
      <div className="memx" data-reveal="">
        <div className="mem-map">
          <svg viewBox="0 0 560 400" role="group" aria-label="Memory map: the project in the middle, what Mnemo remembers around it">
            {nodes.map((n, i) => {
              const p = place(i, nodes.length);
              return <line key={`l${n.id}`} x1="280" y1="200" x2={p.x} y2={p.y} className={n.retired ? "edge retired" : "edge"} />;
            })}
            <g className="hub-node" aria-hidden="true">
              <rect x="222" y="184" width="116" height="32" rx="6" />
              <text x="280" y="205">mnemo-demo</text>
            </g>
            {nodes.map((n, i) => {
              const p = place(i, nodes.length);
              const on = n.id === sel;
              return (
                <g
                  key={n.id}
                  className={["node", on && "on", n.retired && "retired", n.fresh && "fresh"].filter(Boolean).join(" ")}
                  transform={`translate(${p.x} ${p.y})`}
                  tabIndex={0}
                  role="button"
                  aria-pressed={on}
                  aria-label={`${LABELS[n.kind]}: ${n.key}, ${n.value}${n.retired ? " (forgotten)" : ""}`}
                  onClick={() => setSel(n.id)}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setSel(n.id))}
                >
                  <rect x="-7" y="-7" width="14" height="14" className={`sw-${n.kind}`} opacity={0.35 + 0.65 * n.trust} />
                  <text y="24">{n.key.length > 16 ? `${n.key.slice(0, 15)}…` : n.key}</text>
                </g>
              );
            })}
          </svg>
          <ul className="legend" aria-hidden="true">
            {(Object.keys(LABELS) as Kind[]).map((k) => <li key={k}><i className={`bg-${k}`} />{LABELS[k]}</li>)}
          </ul>
        </div>

        <div className="mem-side">
          {selected && (
            <div className="mem-card" aria-live="polite">
              <p className={`kind c-${selected.kind}`}>{LABELS[selected.kind]}{selected.retired ? " · forgotten" : ""}</p>
              <p className="k">{selected.key}</p>
              <p className="v">{selected.value}</p>
              <label className="trust">
                <span>trust</span>
                <meter min={0} max={1} low={0.45} optimum={1} value={selected.trust}>{Math.round(selected.trust * 100)}%</meter>
              </label>
              <div className="mem-actions">
                <button type="button" className="btn sm" disabled={selected.retired || selected.trust <= 0.2} onClick={() => update(selected.id, (n) => ({ ...n, trust: Math.max(0.2, +(n.trust - 0.3).toFixed(2)) }))}>
                  That was wrong
                </button>
                <button type="button" className="btn sm" onClick={() => update(selected.id, (n) => ({ ...n, retired: !n.retired }))}>
                  {selected.retired ? "Bring back" : "/forget"}
                </button>
              </div>
              <p className="fine-sm">“That was wrong” is <code>memory_steer</code>: what memory supplied is trusted less next time. <code>/forget</code> retires it.</p>
            </div>
          )}
          <form className="remember" onSubmit={remember}>
            <label htmlFor="remember-in">/remember</label>
            <input id="remember-in" name="remember" autoComplete="off" spellCheck={false} maxLength={80} placeholder="we deploy with fly…" value={draft} onChange={(e) => setDraft(e.target.value)} />
            <button type="submit" className="btn sm primary">Keep</button>
          </form>
        </div>
      </div>

      <Term title="next session" className="recall" >
        <div className="ln you"><b>▊</b>write a test for the retry</div>
        <div className="ln mem"><b>◆</b>recalled {recalled.length} before the model was asked</div>
        {recalled.map((n) => (
          <div key={n.id} className="fact"><span>{n.key}</span>{n.value}{n.trust < 1 ? <em> · trusted less</em> : null}</div>
        ))}
        {recalled.length === 0 && <div className="ln out">nothing relevant: it starts from the code alone</div>}
      </Term>
    </Section>
  );
}
