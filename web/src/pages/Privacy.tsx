import { DocLayout, Note, type DocSection } from "./parts";
import { REPO } from "../site";

const sections: DocSection[] = [
  {
    id: "summary",
    title: "In short",
    body: (
      <>
        <ul>
          <li><strong>Mnemo, the program, collects nothing.</strong> There is no telemetry, no account and no analytics. What it learns about your projects stays on your machine.</li>
          <li><strong>Your model provider sees your prompts.</strong> That is how an agent works, and it is the one data flow you choose when you pick a provider.</li>
          <li><strong>This website sets no cookies and runs no analytics or advertising.</strong> Its host keeps ordinary server logs.</li>
        </ul>
        <Note tone="ok">There is no profile of you anywhere that we could show, correct or delete, because we never collect one.</Note>
      </>
    ),
  },
  {
    id: "who",
    title: "Who we are",
    body: (
      <p>
        Mnemo is an open-source project maintained by Atman Mishra (<a href="https://github.com/AtmanMishra" rel="author">@AtmanMishra</a> on GitHub). This policy covers the Mnemo software and the website at mnemo.atmanmishra.dev. To ask a question about it, <a href={`${REPO}/issues/new/choose`}>open an issue</a>; for anything sensitive use{" "}
        <a href={`${REPO}/security/advisories/new`}>private reporting</a>.
      </p>
    ),
  },
  {
    id: "software",
    title: "The Mnemo software",
    body: (
      <>
        <h3>What stays on your machine</h3>
        <p>
          Memory (a journal of facts, pitfalls and fixes), sessions, skills, logs, settings and the credentials you add with <code>/login</code> live under <code>~/.mnemo</code> (or <code>$MNEMO_HOME</code>), readable only by you.
          Mnemo never uploads them. Memory writes and session ingestion are redacted for common credential shapes before they are stored; redaction is best effort.
        </p>
        <h3>What leaves your machine</h3>
        <div className="tablewrap">
          <table>
            <thead><tr><th scope="col">When</th><th scope="col">What is sent</th><th scope="col">To whom</th></tr></thead>
            <tbody>
              <tr><td>You send a prompt</td><td>Your prompt, the files and command output the model reads, recalled memory</td><td>The model provider you configured</td></tr>
              <tr><td>You run <code>mnemo update</code></td><td>A request for the latest release and its files</td><td>GitHub</td></tr>
              <tr><td>You turned on the daily check (off by default)</td><td>A request for the latest release; nothing about you</td><td>GitHub</td></tr>
              <tr><td>You set <code>MNEMO_EMBED_URL</code></td><td>The text of memories, to compute embeddings</td><td>The server you chose (OpenRouter, or an Ollama on your machine)</td></tr>
              <tr><td>You run an installer</td><td>A download request</td><td>This site or GitHub</td></tr>
            </tbody>
          </table>
        </div>
        <p>Commands such as <code>--version</code>, <code>doctor</code>, <code>--demo</code> and <code>memory status</code> open no network connection. Providers, GitHub and OpenRouter have their own privacy policies, which apply to what they receive.</p>
        <h3>Deleting it</h3>
        <p><code>mnemo uninstall --deep</code> removes the program and everything Mnemo kept. Without <code>--deep</code> your memory and settings stay for a later install. <code>/forget</code> retires a single remembered fact.</p>
      </>
    ),
  },
  {
    id: "website",
    title: "This website",
    body: (
      <>
        <ul>
          <li><strong>Hosting.</strong> The site is served by Vercel. Like any web host, it processes request metadata (your IP address, the page asked for, your browser's user agent and the time) to deliver the page and to keep it secure, and it keeps standard server logs for a limited time under its own policy.</li>
          <li><strong>No cookies, no trackers.</strong> The site loads nothing from third parties: its content security policy allows scripts, styles, images and fonts from its own address only.</li>
          <li><strong>One thing is remembered on your device:</strong> if you pick a light or dark theme with the toggle, the choice is kept in your browser's local storage under <code>mnemo-theme</code>. It never leaves your browser. Clear it any time by choosing "system" or clearing site data.</li>
          <li><strong>Forms.</strong> There are none. The search boxes on the changelog and shortcuts pages filter the page in your browser and send nothing.</li>
          <li><strong>Links away.</strong> Pages link to GitHub and other sites. Once you follow a link, that site's policy applies.</li>
        </ul>
      </>
    ),
  },
  {
    id: "basis",
    title: "Why the logs, and your rights",
    body: (
      <>
        <p>
          The only personal data involved is what your browser sends to the web host. It is used to serve the site and keep it secure and reliable, which is a legitimate interest, and is not sold, shared for advertising or combined with anything else.
          Under laws such as the GDPR you may have rights to access, correct or delete personal data and to object to its processing; we hold none beyond those host logs, so the requests that make sense go to the host, Vercel.
          Nothing in this policy limits rights you have under law.
        </p>
        <p>The site is not directed at children, and the software collects nothing about anyone, children included.</p>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes",
    body: (
      <p>
        If this policy changes, the date above changes with it and the previous text stays in the <a href={`${REPO}/commits/main/web/src/pages/Privacy.tsx`}>repository history</a>. A change that would make Mnemo collect anything it does not collect today would be announced in the{" "}
        <a href="/changelog">changelog</a> first, and would be off unless you turned it on.
      </p>
    ),
  },
];

export function Privacy() {
  return (
    <DocLayout
      eyebrow="privacy policy"
      title="Privacy policy"
      lead={<>Mnemo collects nothing. This page says exactly what the software and this website do with data, in plain words.</>}
      updated="2026-10-13"
      sections={sections}
    />
  );
}
