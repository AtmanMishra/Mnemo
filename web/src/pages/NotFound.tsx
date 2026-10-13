import { ROUTES } from "../routes";

export function NotFound() {
  return (
    <div className="wrap page notfound">
      <img src="/mne.svg" alt="Mne, the pixel elephant" width="120" height="120" />
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
