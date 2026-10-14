import { Cmd, DocLayout, Note, type DocSection } from "./parts";
import { REPO } from "../site";

const sections: DocSection[] = [
  {
    id: "quickstart",
    title: "Quick start",
    body: (
      <>
        <p>Three commands from nothing to a working agent. The first line is for macOS and Linux; Windows is just below.</p>
        <Cmd text="curl -fsSL https://mnemo.atmanmishra.dev/install.sh | sh" />
        <Cmd prompt="PS> " text="irm https://mnemo.atmanmishra.dev/install.ps1 | iex" />
        <Cmd text="mnemo doctor" />
        <Cmd text="mnemo" />
        <p>
          On first run type <code>/login</code> to add a provider key or subscription, then <code>/model</code> to choose a model. No key yet? <code>mnemo --demo</code> plays a scripted session in a scratch
          project so you can see a turn first. Prefer a download button? <a href="/download">The download page</a> has one for your system.
        </p>
      </>
    ),
  },
  {
    id: "install",
    title: "Installing",
    body: (
      <>
        <p>
          The installer downloads one archive holding <code>mnemo</code> and its memory sidecar <code>memsrv</code>, checks its SHA-256 against the release's checksum file, puts both in{" "}
          <code>~/.mnemo/bin</code> (<code>%USERPROFILE%\.mnemo\bin</code> on Windows) and links <code>mnemo</code> onto your PATH. On a terminal it draws itself as it goes; piped, or with{" "}
          <code>NO_COLOR</code>, it prints plain lines. It never touches your memory or settings, and running it again upgrades in place.
        </p>
        <h3>Three ways</h3>
        <ul>
          <li><strong>One-line installer</strong>: the commands above. <a href="/install.sh">Read the script first</a> if you like.</li>
          <li><strong>A downloaded archive</strong>: from <a href="/download">/download</a>. Unpack it and keep <code>mnemo</code> and <code>memsrv</code> in the same folder on your PATH. On Windows, double-click <code>mnemo.exe</code> in the unzipped folder instead: it offers to put both in <code>%USERPROFILE%\.mnemo\bin</code> and add that to your PATH (<code>mnemo install</code> does the same from a terminal; <code>--yes</code> skips the question).</li>
          <li><strong>From source</strong>: needs Bun and a Rust toolchain. <a href={`${REPO}/blob/main/CONTRIBUTING.md`}>CONTRIBUTING.md</a> has the steps.</li>
        </ul>
        <h3>Installer options</h3>
        <p>Set these before the command (for example <code>MNEMO_HOME=/opt/mnemo curl … | sh</code>):</p>
        <ul>
          <li><code>MNEMO_HOME</code>: where Mnemo lives (default <code>~/.mnemo</code>).</li>
          <li><code>sh -s -- --uninstall</code> / <code>--deep</code> (Windows: <code>$env:MNEMO_UNINSTALL=1</code>, <code>deep</code>): remove it. See <a href="#uninstall">uninstalling</a>.</li>
        </ul>
        <Note tone="note" title="The checksum">
          It catches a corrupted download, not a compromised release (the checksum is published beside the archive). To check provenance, see{" "}
          <a href="/download#verify">verifying a download</a>.
        </Note>
      </>
    ),
  },
  {
    id: "first-run",
    title: "First run",
    body: (
      <>
        <ol>
          <li><code>mnemo doctor</code> reports the model, the memory sidecar and Python. Add <code>--fix</code> to repair what it can (file permissions, a broken settings file, a missing sidecar).</li>
          <li>Start Mnemo in a project folder: <code>cd my-project &amp;&amp; mnemo</code>. It asks once whether to trust the folder's own <code>.pi/</code> extensions and prompts.</li>
          <li><code>/login</code> adds a provider; <code>/model</code> chooses the model; <code>/thinking</code> sets how hard it thinks. Mnemo also uses keys it finds in your environment, such as <code>ANTHROPIC_API_KEY</code>.</li>
          <li>Ask for something. By default it asks before every edit and command. <code>shift+tab</code> cycles the mode.</li>
          <li>Type <code>/</code> for the command menu, <code>@</code> to mention a file, <code>ctrl+k</code> to jump anywhere. Everything is on <a href="/shortcuts">the shortcuts page</a>.</li>
        </ol>
      </>
    ),
  },
  {
    id: "modes",
    title: "Permission modes",
    body: (
      <>
        <p>The mode decides what Mnemo may do without asking. Only you can change it; it is never a tool the model can call.</p>
        <div className="tablewrap">
          <table>
            <thead><tr><th scope="col">Mode</th><th scope="col">What happens</th><th scope="col">Switch</th></tr></thead>
            <tbody>
              <tr><th scope="row"><code>default</code></th><td>Asks before every edit and every command that is not clearly read-only.</td><td><code>/mode</code></td></tr>
              <tr><th scope="row"><code>accept-edits</code></th><td>Edits project files freely; still asks before commands.</td><td><code>/accept-edits</code>, <code>--accept-edits</code></td></tr>
              <tr><th scope="row"><code>plan</code></th><td>Read-only. Nothing is changed.</td><td><code>/plan</code>, <code>--plan</code></td></tr>
              <tr><th scope="row"><code>yolo</code></th><td>Asks for nothing. Only <code>deny</code> rules still hold.</td><td><code>/yolo</code>, <code>--yolo</code></td></tr>
            </tbody>
          </table>
        </div>
        <p>
          Put rules in <code>~/.mnemo/permissions.json</code> (<code>allow</code>, <code>ask</code>, <code>deny</code>; first match wins, and a deny beats every mode). A file that exists but cannot be parsed stops all edits and
          commands until it is fixed.
        </p>
        <Note tone="warn" title="A filter, not a sandbox">
          Anything you approve runs with your permissions, and headless mode (<code>mnemo -p</code>) allows every call that would ask. Use it and <code>yolo</code> in a container or a throwaway checkout.
          Details on <a href="/security">the security page</a>.
        </Note>
      </>
    ),
  },
  {
    id: "memory",
    title: "Memory",
    body: (
      <>
        <p>
          After each run Mnemo writes down what it learned about the project and about you, recalls it in the next session, keeps the fix when something failed, and writes skills for itself. It all lives in a local,
          append-only journal that only you can read: <code>~/.mnemo/memory/journal.jsonl</code>. Nothing is uploaded.
        </p>
        <ul>
          <li><code>/memory</code> shows what it remembers; <code>/memory deploy</code> searches it.</li>
          <li><code>/remember we deploy with fly</code> tells it something to keep; <code>/forget package manager</code> retires a fact.</li>
          <li>The memory pane (sidebar, key <kbd>2</kbd>): <kbd>+</kbd> / <kbd>-</kbd> say an item helped or was wrong, <kbd>e</kbd> edits, <kbd>d</kbd> forgets, <kbd>m</kbd> opens the map.</li>
          <li><code>mnemo memory tidy</code> lists duplicates, facts about files that are gone, and what you marked wrong; <code>--apply</code> retires them.</li>
          <li>Recall is trust-weighted: what helped ranks higher, and what you marked wrong twice stops coming back.</li>
        </ul>
        <h3>Search quality</h3>
        <p>
          Search uses a local hashing embedder, which is offline and plain. To do better, point it at your own embedding server (an Ollama on this machine, say) with{" "}
          <code>MNEMO_EMBED_URL</code> and <code>MNEMO_EMBED_MODEL</code>. If <code>OPENROUTER_API_KEY</code> is set, the text of memories goes to OpenRouter to compute embeddings; leave it unset and nothing is sent.
        </p>
        <h3>Share it with other agents</h3>
        <p>The same memory can serve Claude Code (hooks) and Codex, Cursor and opencode (MCP):</p>
        <Cmd text="mnemo memory setup claude-code" />
        <Cmd text="mnemo memory setup codex" />
        <Cmd text="mnemo memory ingest" />
        <p className="fine-sm">Only attach memory to agents and repositories you trust with all of it: a project's identity comes from its git origin.</p>
      </>
    ),
  },
  {
    id: "update",
    title: "Updating",
    body: (
      <>
        <Cmd text="mnemo update" />
        <p>Installs the latest release with the same checksum-checked installer. Inside Mnemo, <code>/update</code> does the same. On Windows the running <code>mnemo.exe</code> can be replaced, so this works from inside the app.</p>
        <ul>
          <li><code>mnemo update --check</code> only says whether there is a newer version.</li>
          <li><code>mnemo update --auto on</code> adds a daily check at launch that <em>tells</em> you and never installs on its own. <strong>Off by default</strong>; until you turn it on, Mnemo contacts nothing but your model provider.</li>
          <li>Installed with Homebrew or Scoop? Use <code>brew upgrade mnemo</code> or <code>scoop update mnemo</code>.</li>
          <li>Pre-releases and older versions are on <a href={`${REPO}/releases`}>GitHub</a>; what changed is in the <a href="/changelog">changelog</a>.</li>
        </ul>
      </>
    ),
  },
  {
    id: "uninstall",
    title: "Uninstalling",
    body: (
      <>
        <Cmd text="mnemo uninstall" />
        <p>Removes the program (<code>mnemo</code>, <code>memsrv</code> and the PATH link). <strong>What it learned stays</strong>: memory, sessions, credentials and settings, so a later install picks up where you left off.</p>
        <Cmd text="mnemo uninstall --deep" />
        <p>
          Also deletes <code>~/.mnemo</code>: memory, sessions, credentials, skills, logs and settings. It lists what it will remove and waits until you type <code>delete</code>. Add <code>--yes</code> to skip the questions in a script.
        </p>
        <p>No working <code>mnemo</code>? The installer does the same, from the same address you installed with:</p>
        <Cmd text="curl -fsSL https://mnemo.atmanmishra.dev/install.sh | sh -s -- --uninstall" />
        <Cmd prompt="PS> " text={'$env:MNEMO_UNINSTALL=1; irm https://mnemo.atmanmishra.dev/install.ps1 | iex'} />
        <p className="fine-sm">Add <code>--deep</code> (Windows: <code>$env:MNEMO_UNINSTALL="deep"</code>) for the full removal. Installed with Homebrew or Scoop: <code>brew uninstall mnemo</code> / <code>scoop uninstall mnemo</code>, and <code>mnemo uninstall --deep</code> first if you want the data gone.</p>
      </>
    ),
  },
  {
    id: "files",
    title: "Where things live",
    body: (
      <>
        <p>Everything is under <code>$MNEMO_HOME</code>, which defaults to <code>~/.mnemo</code> and is private to you (mode 0700).</p>
        <div className="tablewrap">
          <table>
            <thead><tr><th scope="col">Path</th><th scope="col">What</th></tr></thead>
            <tbody>
              <tr><td className="n"><code>bin/</code></td><td><code>mnemo</code> and <code>memsrv</code>.</td></tr>
              <tr><td className="n"><code>memory/journal.jsonl</code></td><td>Memory: the append-only journal that is the only source of truth.</td></tr>
              <tr><td className="n"><code>agent/auth.json</code></td><td>Keys you added with <code>/login</code>, mode 0600.</td></tr>
              <tr><td className="n"><code>agent/</code></td><td>Settings, sessions, skills and prompt templates.</td></tr>
              <tr><td className="n"><code>permissions.json</code></td><td>Your allow, ask and deny rules.</td></tr>
              <tr><td className="n"><code>logs/</code></td><td>Redacted JSONL records of tool calls and turns.</td></tr>
            </tbody>
          </table>
        </div>
        <p>Project-level files (<code>.pi/</code> extensions, prompts and skills) load only for folders you trust.</p>
      </>
    ),
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    body: (
      <>
        <p>Start with <code>mnemo doctor</code>; it names what is missing. Then:</p>
        <dl className="defs">
          <dt><code>mnemo: command not found</code></dt>
          <dd>The installer prints the line to add if your PATH lacks its link folder: <code>export PATH="$HOME/.local/bin:$PATH"</code> in <code>~/.profile</code>. Or run <code>~/.mnemo/bin/mnemo</code> directly. On Windows, open a new terminal after installing.</dd>
          <dt>"It is not using my model" / "no model"</dt>
          <dd>Run <code>/login</code> then <code>/model</code>. Mnemo also picks up provider keys from your environment, which can choose a provider by default; unset the ones you do not want.</dd>
          <dt>The memory sidecar is missing or will not start</dt>
          <dd><code>mnemo doctor --fix</code> reinstalls it. If you keep the binaries in different folders, put <code>memsrv</code> beside <code>mnemo</code>. On Windows, a <code>mnemo.exe</code> run from where it was unzipped, or another <code>mnemo</code> earlier on your PATH, is a common cause: <code>mnemo doctor</code> says so, and <code>mnemo install</code> from the unzipped folder fixes it.</dd>
          <dt>Edits and commands are refused</dt>
          <dd>A <code>permissions.json</code> that cannot be parsed blocks them on purpose. Fix the file (or set it aside) and restart. <code>doctor --fix</code> sets a broken settings file aside.</dd>
          <dt>The mouse wheel scrolls Mnemo and I want to select text</dt>
          <dd><code>/mouse</code> toggles it, or start with <code>MNEMO_MOUSE=0</code>.</dd>
          <dt>Links, notifications or animations are unwanted</dt>
          <dd><code>MNEMO_LINKS=0</code>, <code>MNEMO_NOTIFY=0</code>, <code>--no-motion</code> and <code>--no-boot</code>.</dd>
          <dt>A command the agent runs cannot see my API key</dt>
          <dd>That is deliberate. Hand one back with <code>MNEMO_PASS_ENV=NAME</code>.</dd>
        </dl>
        <h3>Still stuck</h3>
        <p>
          <a href={`${REPO}/issues/new/choose`}>Open an issue</a> with the output of <code>mnemo doctor</code> and what you did. Mnemo redacts common credential shapes in its logs, but read
          anything before you paste it. Vulnerabilities go through <a href="/security#report">private reporting</a>, not public issues.
        </p>
      </>
    ),
  },
];

export function Docs() {
  return (
    <DocLayout
      eyebrow="documentation"
      title="Get started with Mnemo"
      lead={<>Install it, give it a model, and know what it may do. The complete lists of commands and keys are on <a href="/shortcuts">their own page</a>.</>}
      updated="2026-10-13"
      sections={sections}
    />
  );
}
