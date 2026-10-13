import { LANES } from "../content/roadmap";
import { REPO } from "../site";
import { PageHead } from "./parts";

export function Roadmap() {
  return (
    <div className="wrap page">
      <PageHead
        eyebrow="roadmap"
        title="Where Mnemo is going"
        lead={<>What is being built, what comes next and what will not happen. It is a statement of intent, not a promise: there are no dates on purpose, and the order changes when real use says it should.</>}
      >
        <p className="cta">
          <a className="btn primary" href={`${REPO}/issues/new/choose`}>Suggest a feature</a>
          <a className="btn" href={`${REPO}/blob/main/docs/ROADMAP.md`}>The engineering task list</a>
        </p>
      </PageHead>

      <nav className="vlist" aria-label="Stages">
        {LANES.map((l) => (
          <a key={l.stage} href={`#${l.stage}`}>{l.title}</a>
        ))}
      </nav>

      {LANES.map((l) => (
        <section key={l.stage} id={l.stage} aria-labelledby={`${l.stage}-h`} className={`block rm-lane rm-${l.stage}`}>
          <h2 id={`${l.stage}-h`}><span className="dot" aria-hidden="true" />{l.title}</h2>
          <p className="lead-sm">{l.blurb}</p>
          <ul className="cards">
            {l.items.map((it) => (
              <li key={it.title} className="card">
                <h3>{it.title}{it.in ? <a className="badge" href={`/changelog#v${it.in}`}>v{it.in}</a> : null}</h3>
                <p>{it.why}</p>
                {it.link ? <p className="fine-sm"><a href={it.link.href}>{it.link.label}</a></p> : null}
              </li>
            ))}
          </ul>
        </section>
      ))}

      <p className="fine">
        Want to shape it? Add a thumbs-up reaction to an <a href={`${REPO}/issues`}>issue</a>, or open one. Every release's changes are in the <a href="/changelog">changelog</a>.
      </p>
    </div>
  );
}
