import { Install } from "./Install";

const REPO = "https://github.com/AtmanMishra/Mnemo";

const cards = [
  { glyph: "◈", title: "It remembers", body: <>After each run Mnemo writes down what it learned about the project and about you, recalls it next session, and keeps the fix when something failed. Memory is local, and what it holds is yours to read (<code>/memory</code>) and delete (<code>/forget</code>).</> },
  { glyph: "◇", title: "Memory is detachable", body: <>One command prints the hooks and MCP entry that attach the same memory to Claude Code or Codex: <code>mnemo memory setup claude-code</code>. What one agent learns, the others recall.</> },
  { glyph: "▣", title: "Many agents, one window", body: <>A hub of every agent and what it is doing, split view for up to four, a project switcher, and a toast when one you are not watching finishes or needs you.</> },
  { glyph: "▞", title: "Pixels, on purpose", body: <>Mne the elephant reacts to the work; diffs and test runs are drawn as pixels; the memory map shows what it holds. Three themes: Night, Game Boy, Paper.</> },
];

const shots = [
  { src: "img/hub.png", alt: "The hub: a card per agent with its status, its last prompt and a pixel per turn", cap: <>The hub: every agent at a glance. <code>ctrl+g</code></> },
  { src: "img/split.png", alt: "Three agents side by side in a split view", cap: <>Split view: up to four agents side by side. <code>ctrl+s</code></> },
  { src: "img/memory-map.png", alt: "The memory map: the project in the middle, its facts, pitfalls and sessions around it", cap: <>The memory map: what it knows about this project.</> },
  { src: "img/best-of.png", alt: "Best-of-three as a race of lanes, the winner in green, then the exit card with Mne waving", cap: <><code>/bestof</code>: three attempts race, the smallest that passes the check wins.</> },
];

const results = [
  { test: "Six tasks in one repo, with rules the code does not reveal (3 runs)", without: "87%", withMem: "100%", win: true },
  { test: "Two repos whose rules conflict (2 runs)", without: "82%", withMem: "99%", win: true },
  { test: "Terminal-Bench subset: 10 easy/medium tasks, one attempt each", without: "10 / 10", withMem: "10 / 10", win: false },
];

export function App() {
  return (
    <div className="wrap">
      <header className="top">
        <a className="brand" href="/"><img src="/favicon.svg" alt="" width="24" height="24" />mnemo</a>
        <nav aria-label="Primary">
          <a href="#install">install</a>
          <a href="#measured">what we measured</a>
          <a href="#safety">safety</a>
          <a href={REPO}>github</a>
        </nav>
      </header>

      <main>
        <div className="hero">
          <div>
            <span className="tag">pre-alpha · open source · Apache-2.0</span>
            <h1><img className="wordmark" src="/wordmark.svg" alt="MNEMO" width="480" height="66" /></h1>
            <p className="lead">A terminal coding agent with a memory that <em>learns your projects</em>. Several agents in one window. Bring your own model.</p>
          </div>
          <img className="mne" src="/mne.svg" alt="Mne, the pixel elephant: elephants never forget" width="220" height="220" />
        </div>

        <Install />

        <section aria-labelledby="what">
          <h2 id="what">What it is</h2>
          <div className="grid">
            {cards.map((c) => (
              <div className="card" key={c.title}><span className="glyph">{c.glyph}</span><h3>{c.title}</h3><p>{c.body}</p></div>
            ))}
          </div>
        </section>

        <section aria-labelledby="shots">
          <h2 id="shots">The interface</h2>
          <div className="shots">
            {shots.map((s) => (
              <figure key={s.src}><img src={`/${s.src}`} alt={s.alt} loading="lazy" /><figcaption>{s.cap}</figcaption></figure>
            ))}
          </div>
        </section>

        <section aria-labelledby="measured">
          <h2 id="measured">What we measured</h2>
          <p className="fine">All on a small, cheap model (DeepSeek v4.1 Flash), through the same agent loop with memory on and off. Small samples: read the direction, not the decimals. The raw results and what went wrong along the way are in <a href={`${REPO}/tree/main/research`}>research/</a>.</p>
          <table>
            <thead><tr><th>Test</th><th>No memory</th><th>With memory</th></tr></thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.test}><td>{r.test}</td><td className="n">{r.without}</td><td className={r.win ? "n good" : "n"}>{r.withMem}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="fine">The last row is the honest one: unrelated one-off tasks in a fresh container give memory nothing to remember, and it makes no difference there (about $0.008 a task either way). It is a subset on our own machine, not comparable to the public leaderboard. The first two are where memory is supposed to pay off. Against a simpler, global memory in the style of Hermes Agent, Mnemo matched it at one or two repos and was ahead where it keeps projects apart (a command learned in one project was offered in another) and picks up unfinished work. The comparison is written up in <a href={`${REPO}/blob/main/research/hermes-comparison.md`}>research/hermes-comparison.md</a>.</p>
        </section>

        <section aria-labelledby="safety">
          <h2 id="safety">Before you run it</h2>
          <p>Mnemo is a coding agent: it reads your files, edits them and runs shell commands as you. By default it asks before every edit and command; <code>yolo</code> and headless <code>-p</code> ask for nothing, so use those in a container or a throwaway checkout. The permission gate filters what runs; it is not a sandbox.</p>
          <p>Your prompts and the files the model reads go to the provider you chose, and nothing else leaves your machine: there is no telemetry and no update check (we measured it). Commands the agent runs inherit your environment, provider keys included, which a prompt injection could try to read; <a href={`${REPO}/blob/main/SECURITY.md`}>SECURITY.md</a> says what to do about that today. It is pre-alpha software: expect rough edges and <a href={`${REPO}/issues`}>tell us about them</a>.</p>
        </section>
      </main>

      <footer>
        <span>Apache-2.0</span>
        <a href={REPO}>source</a>
        <a href={`${REPO}/releases`}>releases</a>
        <a href={`${REPO}/blob/main/SECURITY.md`}>security</a>
        <a href={`${REPO}/blob/main/docs/ROADMAP.md`}>roadmap</a>
        <a href={`${REPO}/blob/main/CONTRIBUTING.md`}>contribute</a>
      </footer>
    </div>
  );
}
