import { Section } from "./Section";
import { useInView } from "../hooks";
import { REPO } from "../site";

const ROWS = [
  { test: "Six tasks in one repo, with rules the code does not reveal (3 runs)", off: 87, on: 100 },
  { test: "Two repos whose rules conflict (2 runs)", off: 82, on: 99 },
  { test: "Terminal-Bench subset: 10 easy/medium tasks, one attempt each", off: 100, on: 100, raw: "10 / 10" },
];

export function Measured() {
  const [ref, seen] = useInView<HTMLDivElement>(0.3);
  return (
    <Section
      id="measured"
      n="11"
      eyebrow="what we measured"
      title="Does the memory make a small model better?"
      lead={<>On a small, cheap model (DeepSeek v4.1 Flash), through the same agent loop with memory on and off: from 87% to 100% on a six-task repository and from 82% to 99% on two repositories with conflicting rules. On unrelated one-off tasks it made no difference. Small samples: read the direction, not the decimals.</>}
    >
      <div ref={ref} className={seen ? "bars seen" : "bars"} data-reveal="">
        {ROWS.map((r) => (
          <div key={r.test} className="bar-row">
            <p>{r.test}</p>
            <div className="mbar off"><i className={`w${r.off}`} /><span>no memory · {r.raw ?? `${r.off}%`}</span></div>
            <div className="mbar on"><i className={`w${r.on}`} /><span>memory · {r.raw ?? `${r.on}%`}</span></div>
          </div>
        ))}
      </div>
      <p className="fine" data-reveal="">
        The last row is the honest one: unrelated tasks in a fresh container give memory nothing to remember (about $0.008 a task either way), and it is a subset on our own machine, not comparable to the public leaderboard. Against a simpler, global memory in the style of Hermes Agent, Mnemo matched it at one or two repos and was ahead where it keeps projects apart and picks up unfinished work. Raw results: <a href={`${REPO}/tree/main/research`}>research/</a>, <a href={`${REPO}/blob/main/research/hermes-comparison.md`}>hermes-comparison.md</a>.
      </p>
    </Section>
  );
}
