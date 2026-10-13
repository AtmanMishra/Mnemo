import { useEffect, useMemo, useRef, useState } from "react";
import { GROUPS } from "../content/commands";
import { VERSION } from "../site";
import { Inline, PageHead } from "./parts";

export function Shortcuts() {
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState("all");
  const search = useRef<HTMLInputElement>(null);

  // "/" jumps to the search box, the way the app's own menu does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      search.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const q = query.trim().toLowerCase().replace(/`/g, "");
  const shown = useMemo(
    () =>
      GROUPS.filter((g) => only === "all" || g.id === only)
        .map((g) => ({ ...g, rows: q ? g.rows.filter(([k, d]) => (k + " " + d).toLowerCase().replace(/`/g, "").includes(q)) : g.rows }))
        .filter((g) => g.rows.length > 0),
    [q, only],
  );
  const count = shown.reduce((n, g) => n + g.rows.length, 0);

  return (
    <div className="wrap page shortcuts">
      <PageHead
        eyebrow={`mnemo ${VERSION}`}
        title="Commands and shortcuts"
        lead={<>Everything you can type or press. In the app, <kbd>/</kbd> opens the command menu and <code>/help</code> prints this list.</>}
      >
        <p className="cta">
          <button type="button" className="btn" onClick={() => window.print()}>Print or save as PDF</button>
          <a className="btn" href="/mnemo-commands-and-shortcuts.md" download>Download as Markdown</a>
        </p>
      </PageHead>

      <div className="filters" role="search">
        <label className="visually-hidden" htmlFor="sc-q">Search commands, keys and variables</label>
        <input id="sc-q" ref={search} type="search" placeholder="Search: rewind, ctrl+f, MNEMO_HOME …   (press / to focus)" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" spellCheck={false} />
        <div className="chips" role="group" aria-label="Show">
          <button type="button" aria-pressed={only === "all"} onClick={() => setOnly("all")}>All</button>
          {GROUPS.map((g) => (
            <button key={g.id} type="button" aria-pressed={only === g.id} onClick={() => setOnly(g.id)}>{g.title.replace(/ \(.*\)/, "")}</button>
          ))}
        </div>
        <p className="fine-sm" aria-live="polite">{q || only !== "all" ? `${count} ${count === 1 ? "match" : "matches"}` : `${count} entries`}</p>
      </div>

      {shown.length === 0 ? (
        <p className="empty">Nothing matches "{query}". Try fewer letters, or <button type="button" className="linklike" onClick={() => { setQuery(""); setOnly("all"); }}>clear the filter</button>.</p>
      ) : (
        shown.map((g) => (
          <section key={g.id} id={g.id} aria-labelledby={`${g.id}-h`} className="block">
            <h2 id={`${g.id}-h`}>{g.title}</h2>
            {g.intro ? <p className="lead-sm">{g.intro}</p> : null}
            <div className="tablewrap">
              <table className="keys">
                <thead><tr><th scope="col">{g.id === "env" ? "Variable" : g.id === "slash" || g.id === "cli" ? "Command" : "Key"}</th><th scope="col">What it does</th></tr></thead>
                <tbody>
                  {g.rows.map(([k, d]) => (
                    <tr key={k}>
                      <th scope="row"><Inline text={k} kbd={g.id !== "slash" && g.id !== "cli" && g.id !== "env"} /></th>
                      <td><Inline text={d} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {g.after ? <p className="fine"><Inline text={g.after} /></p> : null}
          </section>
        ))
      )}
    </div>
  );
}
