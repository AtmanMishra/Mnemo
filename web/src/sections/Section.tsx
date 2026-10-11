import type { ReactNode } from "react";
import { Split } from "../Split";

/** One feature: a numbered eyebrow, a question-style heading, a direct answer, then the demo. */
export function Section({ id, n, eyebrow, title, lead, children, className }: { id: string; n: string; eyebrow: string; title: string; lead: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={className ? `feature ${className}` : "feature"} aria-labelledby={id}>
      <p className="eyebrow" data-reveal=""><span>{n}</span> {eyebrow}</p>
      <Split id={id} text={title} />
      <p className="lead-sm" data-reveal="">{lead}</p>
      {children}
    </section>
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
