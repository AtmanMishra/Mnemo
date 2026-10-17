import { ROUTES } from "../routes";

export function NotFound() {
  return (
    <div className="wrap page notfound">
      <div className="notfound-slot" data-stage-anchor="" aria-hidden="true" />
      <h1>Nothing here.</h1>
      <p className="lead">Mne looked and does not remember this page.</p>
      <ul className="cards">
        {ROUTES.filter((r) => r.path !== "/").map((r) => (
          <li key={r.path} className="card"><h3><a href={r.path}>{r.label}</a></h3></li>
        ))}
      </ul>
      <p className="cta"><a className="btn primary" href="/">Back to Mnemo</a></p>
    </div>
  );
}
