import { PageHead } from "./parts";
import { Split } from "../Split";
import { TypeOut } from "../TypeOut";
import { AREAS } from "../fx/theme";
import { REPO } from "../site";

const LOOP: [string, string][] = [
  ["Recall", "Before the model sees your message, memory is searched for it and what it finds is attached: facts, earlier sessions, pitfalls with their fixes, skills. Recalled items are candidates, never presented as fact."],
  ["Work", "Thinking, text and tool calls stream in as they arrive. It reads before it edits, and a change is checked before it is called done."],
  ["Gate", "Every tool call passes the permission gate. Reads run; edits and commands ask, unless your mode or rules say otherwise, and a deny rule always holds."],
  ["Steer", "Each tool call and its outcome is logged with its subject. A failure steers memory right away, once per distinct failure, so the same mistake is less likely in the same run."],
  ["Reflect", "After the run, a clean run reinforces the memories that fed it, and one grounded reflection writes the session record, new facts, the fixes that worked, and a skill when one was shown."],
];

const AREA_TEXT = [
  "Episodes and their outcomes: what happened in each session, and how it ended.",
  "Facts about the project and about you. The default home for a memory.",
  "Harnesses and skills: how things are done here, step by step.",
  "Where things are: repositories, paths, services.",
  "Pain markers: what hurt, so it is recalled before it hurts again.",
  "Steering decisions: what was decided about how to work.",
];

const TOPOLOGY = `terminal ─▶ mnemo  (Bun: the Ink interface and a pi session, one process)
              ├── stdin/stdout JSON-RPC ─▶ memsrv (Rust) ──▶ memory/journal.jsonl (locked)
              ├── stdin/stdout JSONL     ─▶ python3 ipy_bridge.py   (the ipy_run tool)
              └── in process             ─▶ sub-agents (more pi sessions on the same host)

Claude Code hooks, MCP clients ─▶ mnemo memory hook|mcp ─▶ its own memsrv ─▶ the same journal`;

const RECALL = `your message
   │
   ├─▶ route     cue phrases pick up to two areas  (a bias, not a filter)
   ├─▶ embed     the query, then cosine against every live node
   ├─▶ weigh     usefulness so far, and 0.85 for nodes outside the routed areas
   ├─▶ expand    one hop along live edges: part of, supplies context, derived from
   └─▶ attach    the top results go in front of the model, marked as candidates`;

const OPS = ["CreateNode", "AddFact", "SupersedeFact", "SetArea", "DeleteNode", "Link", "Unlink", "Reweight", "RecordOutcome", "PushContext", "CommitLog", "RecordUsefulness"];
const EDGES: [string, string][] = [
  ["SuppliesContext", "this memory owes that one correct context"],
  ["PartOf", "an aspect belongs to a cluster, such as a project"],
  ["DerivedFrom", "an episode or outcome cites the memories it used"],
  ["Supersedes", "a newer value replaced this one, which is kept"],
  ["ActivatedWith", "recalled together before: an association that grows with use"],
];

export function HowItWorks() {
  return (
    <div className="page how-page">
      <div className="wrap">
        <PageHead
          eyebrow="How it works"
          title="How Mnemo remembers"
          lead={<>A memory you can read: a graph of nodes and typed edges in six areas, kept as one append-only journal on your machine. It is searched before every message and written to after every run. This is how, from <a href={`${REPO}/blob/main/docs/MNEMO-INTERNALS.md`}>the internals document</a>.</>}
        />
      </div>

      <section className="loop-sec" aria-labelledby="loop-h">
        <div className="wrap">
          <p className="eyebrow" data-reveal=""><span className="ribbon-tag">The loop</span></p>
          <Split id="loop-h" text="Every turn, five steps" />
          <ol className="loop">
            {LOOP.map(([t, d], i) => (
              <li key={t} data-reveal="">
                <span className="loop-n">{i + 1}</span>
                <h3>{t}</h3>
                <p>{d}</p>
              </li>
            ))}
          </ol>
          <p className="fine" data-reveal="">Want to see one? <a href="/features#demo">Step through a whole turn</a>.</p>
        </div>
      </section>

      <section className="areas" data-scene="areas" aria-labelledby="areas-h">
        <div className="wrap areas-grid">
          <div>
            <p className="eyebrow" data-reveal=""><span className="ribbon-tag">The graph</span></p>
            <Split id="areas-h" text="Six areas, like a brain" />
            <p className="lead-sm" data-reveal="">Every node is filed in an area, each named for the part of the brain it is modelled on. A query is routed to the areas its words point at, but routing only biases the search: a mis-routed query still finds its node.</p>
            <ol className="area-list">
              {AREAS.map((a, i) => (
                <li key={a} data-area={i} className={`area-${i}`}>
                  <i aria-hidden="true" />
                  <h3>{a}</h3>
                  <p>{AREA_TEXT[i]}</p>
                </li>
              ))}
            </ol>
          </div>
          <div className="areas-pin" aria-hidden="true"><div className="areas-anchor" data-areas-anchor="" /></div>
        </div>
      </section>

      <section className="anatomy" aria-labelledby="anatomy-h">
        <div className="wrap anatomy-grid">
          <div>
            <p className="eyebrow" data-reveal=""><span className="ribbon-tag">Nodes and edges</span></p>
            <Split id="anatomy-h" text="A node is a list of facts with a history" />
            <p className="lead-sm" data-reveal="">A node has a kind (aspect, task episode, entity, harness or outcome), an area, a label, its facts and an append-only log. A fact is a key with one current value: writing a new value supersedes the old one, which keeps its id and stays readable as history. Edges are typed, weighted and directed, and count their successes and failures.</p>
          </div>
          <ul className="edge-list" data-reveal="">
            {EDGES.map(([k, d]) => (
              <li key={k}><code>{k}</code><span>{d}</span></li>
            ))}
          </ul>
        </div>
      </section>

      <section className="journal" aria-labelledby="journal-h">
        <div className="wrap">
          <p className="eyebrow" data-reveal=""><span className="ribbon-tag">The journal</span></p>
          <Split id="journal-h" text="Twelve ways to change it, and none of them erase" />
          <p className="lead-sm" data-reveal="">State changes only through twelve operations, appended one line each to <code>~/.mnemo/memory/journal.jsonl</code>. Replaying the journal gives back the graph exactly, so the journal is the source of truth. Several processes share it under a lock, and even deleting a node is soft by default.</p>
          <ul className="ops" data-reveal="">
            {OPS.map((o) => <li key={o}><code>{o}</code></li>)}
          </ul>
        </div>
      </section>

      <section className="ascii-sec" aria-labelledby="recall-h">
        <div className="wrap">
          <p className="eyebrow" data-reveal=""><span className="ribbon-tag">Recall</span></p>
          <Split id="recall-h" text="What happens to your message first" />
          <div className="crt" data-reveal="">
            <TypeOut text={RECALL} label="Recall: route the message to up to two areas, embed it and score every live node by cosine, weigh by usefulness and area, expand one hop along live edges, attach the top results as candidates." />
          </div>
          <p className="fine" data-reveal="">Embeddings are a deterministic, offline 256-dimension hash by default, or a server you opt in to. Brute force is fine to about 100,000 nodes.</p>
        </div>
      </section>

      <section className="ascii-sec" aria-labelledby="topo-h">
        <div className="wrap">
          <p className="eyebrow" data-reveal=""><span className="ribbon-tag">The parts</span></p>
          <Split id="topo-h" text="One process, two pipes, one journal" />
          <div className="crt" data-reveal="">
            <TypeOut text={TOPOLOGY} cps={1400} label="mnemo is one Bun process with the interface and the agent session. It talks to memsrv, the Rust memory sidecar that owns the journal, and to a Python kernel, over pipes; sub-agents run in the same process. Claude Code hooks and MCP clients reach the same journal through their own memsrv." />
          </div>
          <p className="cta" data-reveal="">
            <a className="btn primary big" href="/download">Download Mnemo</a>
            <a className="btn big alt" href="/docs">Read the docs</a>
          </p>
        </div>
      </section>
    </div>
  );
}
