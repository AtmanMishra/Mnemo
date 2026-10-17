import { useState, type ReactNode } from "react";
import { Split } from "../Split";

/** Text with `backticks` turned into <code> (or <kbd>, for keys). */
export function Inline({ text, kbd }: { text: string; kbd?: boolean }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((p, i) => (i % 2 ? (kbd ? <kbd key={i}>{p}</kbd> : <code key={i}>{p}</code>) : p ? <span key={i}>{p}</span> : null))}
    </>
  );
}

/** A page's top: eyebrow, heading, lead and (optionally) actions. */
export function PageHead({ eyebrow, title, lead, children }: { eyebrow: string; title: string; lead: ReactNode; children?: ReactNode }) {
  return (
    <header className="pagehead">
      <div className="pagehead-copy">
        <p className="eyebrow" data-intro=""><span className="ribbon-tag">{eyebrow}</span></p>
        <Split as="h1" text={title} hero />
        <p className="lead" data-intro="">{lead}</p>
        {children ? <div className="pagehead-extra" data-intro="">{children}</div> : null}
      </div>
      {/* The memory graph floats here (the stage follows this box). */}
      <div className="pagehead-slot" data-stage-anchor="" aria-hidden="true" />
    </header>
  );
}

export interface DocSection {
  id: string;
  title: string;
  body: ReactNode;
}

/** A long page with a sticky table of contents (a plain list on a phone). */
export function DocLayout({ eyebrow, title, lead, updated, sections, aside }: {
  eyebrow: string;
  title: string;
  lead: ReactNode;
  /** ISO date of the last substantive change; shown, so a reader can tell how old the page is. */
  updated?: string;
  sections: DocSection[];
  aside?: ReactNode;
}) {
  return (
    <div className="wrap page">
      <PageHead eyebrow={eyebrow} title={title} lead={lead}>
        {updated ? <p className="fine-sm">Last updated <time dateTime={updated}>{updated}</time></p> : null}
      </PageHead>
      <div className="doc">
        <nav className="toc" aria-label="On this page">
          <p>On this page</p>
          <ol>
            {sections.map((s) => (
              <li key={s.id}><a href={`#${s.id}`}>{s.title}</a></li>
            ))}
          </ol>
          {aside}
        </nav>
        <div className="prose">
          {sections.map((s) => (
            <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`}>
              <h2 id={`${s.id}-h`}><a className="anchor" href={`#${s.id}`} aria-label={`Link to ${s.title}`}>#</a>{s.title}</h2>
              {s.body}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A code block with a copy button. */
export function Cmd({ text, prompt = "$ " }: { text: string; prompt?: string }) {
  const [done, setDone] = useState(false);
  const copy = () => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(
      () => {
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      },
      () => {},
    );
  };
  return (
    <div className="cmd">
      <code translate="no">
        <span className="prompt" aria-hidden="true">{prompt}</span>
        {text}
      </code>
      <button type="button" className={done ? "copy done" : "copy"} onClick={copy} aria-label={`Copy: ${text}`}>
        <span className="copy-a">copy</span>
        <span className="copy-b" aria-live="polite">{done ? "copied" : ""}</span>
      </button>
    </div>
  );
}

/** A callout: a note, a warning, or good news. */
export function Note({ tone = "note", title, children }: { tone?: "note" | "warn" | "ok"; title?: string; children: ReactNode }) {
  return (
    <aside className={`callout ${tone}`}>
      {title ? <strong>{title}</strong> : null}
      <div>{children}</div>
    </aside>
  );
}
