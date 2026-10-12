import type { ReactNode } from "react";
import { Split } from "../Split";
import { Figure, type FigureName } from "../Figure";

export interface How {
  t: string;
  d: ReactNode;
}

/**
 * One feature: a numbered eyebrow, a question-style heading and a direct answer,
 * beside a Hairline figure that acts the idea out; then "how it works" in detail;
 * then something to try.
 */
export function Section({ id, n, eyebrow, title, lead, figure, how, children, className }: {
  id: string;
  n: string;
  eyebrow: string;
  title: string;
  lead: ReactNode;
  figure?: { name: FigureName; label: string; means: string; intensity?: number };
  how?: How[];
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={className ? `feature ${className}` : "feature"} aria-labelledby={id}>
      <div className={figure ? "f-head with-fig" : "f-head"}>
        <div>
          <p className="eyebrow" data-reveal=""><span>{n}</span> {eyebrow}</p>
          <Split id={id} text={title} />
          <p className="lead-sm" data-reveal="">{lead}</p>
        </div>
        {figure && <Figure {...figure} />}
      </div>
      {how && <HowItWorks items={how} />}
      {children}
    </section>
  );
}

export function HowItWorks({ items, title = "How it works" }: { items: How[]; title?: string }) {
  return (
    <div className="how">
      <h3 className="how-h" data-reveal="">{title}</h3>
      <ol>
        {items.map((it, i) => (
          <li key={it.t} data-reveal="">
            <span className="how-n" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
            <div>
              <h4>{it.t}</h4>
              <p>{it.d}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Terminal chrome for the mock panes. */
export function Term({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={className ? `term ${className}` : "term"}>
      <div className="term-bar" aria-hidden="true"><i /><i /><i /><span>{title}</span></div>
      <div className="term-body">{children}</div>
    </div>
  );
}
