import { useMemo, useState } from "react";
import { AREA_LABEL, KIND_LABEL, RELEASES, type Area, type Kind } from "../content/changelog";
import { REPO } from "../site";
import { PageHead } from "./parts";

const KINDS = Object.keys(KIND_LABEL) as Kind[];
const AREAS = Object.keys(AREA_LABEL) as Area[];

export function Changelog() {
  const [kind, setKind] = useState<Kind | "all">("all");
  const [area, setArea] = useState<Area | "all">("all");
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const releases = useMemo(
    () =>
      RELEASES.map((r) => ({
        ...r,
        changes: r.changes.filter(
          (c) => (kind === "all" || c.kind === kind) && (area === "all" || c.area === area) && (!q || `${c.text} ${c.detail ?? ""}`.toLowerCase().includes(q)),
        ),
      })).filter((r) => r.changes.length > 0 || (kind === "all" && area === "all" && !q)),
    [kind, area, q],
  );
  const filtering = kind !== "all" || area !== "all" || q !== "";
  const total = releases.reduce((n, r) => n + r.changes.length, 0);

  return (
    <div className="wrap page">
      <PageHead
        eyebrow="changelog"
        title="What changed in each release"
        lead={<>Every feature, change, fix and security fix, newest first, with the problems known when each version was cut. Subscribe with the <a href="/changelog.xml">Atom feed</a>, or follow the <a href={`${REPO}/releases`}>releases on GitHub</a>.</>}
      />

      <div className="tools">
        <label className="visually-hidden" htmlFor="cl-q">Search the changelog</label>
        <input id="cl-q" type="search" placeholder="Search the changelog" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" spellCheck={false} />
        <div className="chips" role="group" aria-label="Type of change">
          <button type="button" aria-pressed={kind === "all"} onClick={() => setKind("all")}>All</button>
          {KINDS.map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={`k-${k}`}>{KIND_LABEL[k]}</button>
          ))}
        </div>
        <label className="select">
          <span>Area</span>
          <select value={area} onChange={(e) => setArea(e.target.value as Area | "all")}>
            <option value="all">All areas</option>
            {AREAS.map((a) => (
              <option key={a} value={a}>{AREA_LABEL[a]}</option>
            ))}
          </select>
        </label>
        <p className="fine-sm" aria-live="polite">{filtering ? `${total} ${total === 1 ? "change" : "changes"} match` : `${RELEASES.length} releases`}</p>
      </div>

      <nav className="vlist" aria-label="Versions">
        {RELEASES.map((r) => (
          <a key={r.version} href={`#v${r.version}`}>v{r.version}</a>
        ))}
      </nav>

      <div className="releases">
        {releases.length === 0 ? (
          <p className="empty">Nothing matches. <button type="button" className="linklike" onClick={() => { setKind("all"); setArea("all"); setQuery(""); }}>Clear the filters</button>.</p>
        ) : null}
        {releases.map((r, i) => (
          <article key={r.version} id={`v${r.version}`} className="release" aria-labelledby={`v${r.version}-h`}>
            <header>
              <h2 id={`v${r.version}-h`}>
                <a className="anchor" href={`#v${r.version}`} aria-label={`Link to version ${r.version}`}>#</a>v{r.version}
                {i === 0 && !filtering ? <span className="badge">latest</span> : null}
              </h2>
              <p className="rel-meta"><time dateTime={r.date}>{r.date}</time> · <a href={`${REPO}/releases/tag/v${r.version}`}>release notes and downloads</a></p>
              <p className="rel-head">{r.headline}</p>
            </header>
            {KINDS.map((k) => {
              const list = r.changes.filter((c) => c.kind === k);
              if (!list.length) return null;
              return (
                <section key={k} aria-labelledby={`v${r.version}-${k}`}>
                  <h3 id={`v${r.version}-${k}`} className={`kind k-${k}`}>{KIND_LABEL[k]}</h3>
                  <ul className="changes">
                    {list.map((c) => (
                      <li key={c.text}>
                        <p><strong>{c.text}</strong> <span className="area">{AREA_LABEL[c.area]}</span></p>
                        {c.detail ? <p className="detail">{c.detail}</p> : null}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            {r.known && !filtering ? (
              <section aria-labelledby={`v${r.version}-known`}>
                <h3 id={`v${r.version}-known`} className="kind k-known">Known issues</h3>
                <ul className="changes">
                  {r.known.map((t) => (
                    <li key={t}><p>{t}</p></li>
                  ))}
                </ul>
              </section>
            ) : null}
          </article>
        ))}
      </div>

      <p className="fine">
        Found something that is not listed? <a href={`${REPO}/issues/new/choose`}>Open an issue</a>. Open problems are tracked in the{" "}
        <a href={`${REPO}/issues`}>issue tracker</a>; what is planned is on the <a href="/roadmap">roadmap</a>.
      </p>
    </div>
  );
}
