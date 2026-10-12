import { Section } from "./Section";
import { Term } from "./Section";

// How a failure becomes structure: the memory layer's steer() and reinforce(), and
// how a pitfall comes back (packages/memory: only once it carries a fix).
export function Lessons() {
  return (
    <Section
      id="lessons"
      n="03"
      eyebrow="experience compounds"
      title="What happens when something fails?"
      lead={<>Memory is steered, once per distinct failure. What hurt is marked, the memories that misled the run lose weight, and when a later step fixes the problem the fix is kept with it. Next time the same situation comes up, it is recalled as a pitfall with its fix, before the model repeats the mistake.</>}
      figure={{ name: "sieve", label: "Three test sieves stacked over a pan; the pointer's height lifts one clear of the stack", means: "Every run goes through the sieves: what held up is kept, what misled is caught, and the pan is left bare." }}
      how={[
        { t: "Mark that it hurt", d: <>A pain marker is recorded first, unconditionally, in the salience area. It is linked to the session but never as a source of context, so a marker can never be blamed for the next failure.</> },
        { t: "Blame what fed the run", d: <>Every memory that supplied context to the run is checked against the failure's words; the ones it implicates lose weight. A memory that keeps misleading sinks in the ranking instead of being trusted forever.</> },
        { t: "Correct, if the fix is known", d: <>When the right value is known, the wrong fact is superseded by it, after checking that the old one still exists and is current. History keeps both.</> },
        { t: "Switch to a better source", d: <>When a source's weight falls below 0.2 and a better one exists, the link to the bad one is cut and the alternate takes its place.</> },
        { t: "Reinforce what worked", d: <>A clean run does the mirror image: every memory that fed it gains a little weight, so good context rises the more it is used.</> },
        { t: "Come back as a pitfall with its fix", d: <>Reflection pairs each failure with what resolved it. A pitfall is recalled only once it carries a fix, as a line the model can act on rather than a warning it cannot.</> },
      ]}
    >
      <Term title="a later session, same project" className="recall">
        <div className="ln you"><b>▊</b>run the tests</div>
        <div className="ln mem"><b>◆</b>recalled before the model was asked</div>
        <div className="fact"><span>pitfall</span>tests hang on the dev server port → run them with --runInBand</div>
        <div className="ln tool"><b>●</b>bash <span className="path">pnpm test --runInBand</span></div>
        <div className="ln ok"><b>✓</b>42 passed</div>
      </Term>
    </Section>
  );
}
