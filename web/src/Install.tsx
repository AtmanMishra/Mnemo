import { useEffect, useState, type KeyboardEvent } from "react";
import { REPO } from "./site";

type Tab = "sh" | "ps";

// The one-liner names the address this page is served from, so it is right on any
// domain; before mount, on localhost or over plain http, the GitHub URL stays, so the
// command can never be an http one.
function servedOrigin(): string {
  const { protocol, hostname, origin } = window.location;
  return protocol === "https:" && hostname !== "localhost" ? origin : "";
}

function commands(origin: string): Record<Tab, { prompt: string; text: string }> {
  const base = origin || `${REPO}/releases/latest/download`;
  return {
    sh: { prompt: "$ ", text: `curl -fsSL ${base}/install.sh | sh` },
    ps: { prompt: "PS> ", text: `irm ${base}/install.ps1 | iex` },
  };
}

export function Install() {
  const [origin, setOrigin] = useState("");
  const [tab, setTab] = useState<Tab>("sh");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setOrigin(servedOrigin());
    setTab(/win/i.test(navigator.platform || navigator.userAgent) ? "ps" : "sh");
  }, []);

  const cmd = commands(origin)[tab];
  // WAI-ARIA tabs: one tab stop, arrows move between tabs.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next: Tab = tab === "sh" ? "ps" : "sh";
    setTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  };
  const copy = () => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(cmd.text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => {},
    );
  };

  return (
    <section className="install" id="install" aria-labelledby="install-h" data-reveal="">
      <h2 id="install-h" className="label">Install Mnemo</h2>
      <div className="tabs" role="tablist" aria-label="Operating system" data-tab={tab} onKeyDown={onKey}>
        <span className="tab-ind" aria-hidden="true" />
        <button type="button" role="tab" id="tab-sh" aria-selected={tab === "sh"} tabIndex={tab === "sh" ? 0 : -1} aria-controls="panel" onClick={() => setTab("sh")}>macOS / Linux</button>
        <button type="button" role="tab" id="tab-ps" aria-selected={tab === "ps"} tabIndex={tab === "ps" ? 0 : -1} aria-controls="panel" onClick={() => setTab("ps")}>Windows</button>
      </div>
      <div className="cmd" id="panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        <code translate="no">
          <span className="prompt" aria-hidden="true">{cmd.prompt}</span>
          {cmd.text}
        </code>
        <button type="button" className={copied ? "copy done" : "copy"} onClick={copy} aria-label="Copy the install command">
          <span className="copy-a">copy</span>
          <span className="copy-b" aria-live="polite">{copied ? "copied" : ""}</span>
        </button>
      </div>
      <p className="note">
        The installer checks the download's SHA-256 against the release's checksum file (that catches a corrupted download, not a
        compromised release: <a href={`${REPO}/blob/main/docs/RELEASING.md`}>verify provenance</a> if that matters to you), never
        touches your memory or settings, and upgrades in place when you run it again.{" "}
        <a href={origin ? `${origin}/install.sh` : "/install.sh"}>Read the script first.</a> Prefer a download? <a href="/download#all">Every build, with checksums.</a>
      </p>
      <p className="note">
        Then run <code>mnemo doctor</code> to see what it found, <code>mnemo --demo</code> for a scripted session that needs no API
        key, and <code>mnemo</code> to start. Remove it with <code>… | sh -s -- --uninstall</code> (Windows: set{" "}
        <code>$env:MNEMO_UNINSTALL=1</code> first).
      </p>
    </section>
  );
}
