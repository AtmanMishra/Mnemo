import { useEffect, useState } from "react";
import { Install } from "../Install";
import { LATEST } from "../content/changelog";
import { LATEST_DOWNLOAD, REPO, SITE, VERSION } from "../site";
import { Cmd, Note, PageHead } from "./parts";

interface Target {
  id: string;
  os: "mac" | "linux" | "windows";
  name: string;
  arch: string;
  file: string;
  format: string;
}

const TARGETS: Target[] = [
  { id: "darwin-arm64", os: "mac", name: "macOS", arch: "Apple silicon (M1 and later)", file: "mnemo-darwin-arm64.tar.gz", format: "tar.gz" },
  { id: "darwin-x64", os: "mac", name: "macOS", arch: "Intel", file: "mnemo-darwin-x64.tar.gz", format: "tar.gz" },
  { id: "linux-x64", os: "linux", name: "Linux", arch: "x86-64", file: "mnemo-linux-x64.tar.gz", format: "tar.gz" },
  { id: "linux-arm64", os: "linux", name: "Linux", arch: "ARM64", file: "mnemo-linux-arm64.tar.gz", format: "tar.gz" },
  { id: "windows-x64", os: "windows", name: "Windows", arch: "x64", file: "mnemo-windows-x64.zip", format: "zip" },
];

const url = (file: string) => `${LATEST_DOWNLOAD}/${file}`;

/** The visitor's system, as best the browser says. Architecture is a guess where it cannot be known. */
async function detect(): Promise<Target> {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string; getHighEntropyValues?: (h: string[]) => Promise<{ architecture?: string; bitness?: string }> } };
  const platform = (nav.userAgentData?.platform || navigator.platform || "").toLowerCase();
  const ua = navigator.userAgent.toLowerCase();
  let arch = "";
  try {
    arch = (await nav.userAgentData?.getHighEntropyValues?.(["architecture"]))?.architecture ?? "";
  } catch {
    /* not offered: fall back to the user agent */
  }
  const arm = arch === "arm" || /arm|aarch64/.test(ua);
  const pick = (id: string) => TARGETS.find((t) => t.id === id)!;
  if (/win/.test(platform) || /windows/.test(ua)) return pick("windows-x64");
  if (/mac/.test(platform) || /macintosh|mac os/.test(ua)) {
    // Safari and Firefox report "Intel" on Apple silicon; most Macs sold since 2020 are arm64.
    return pick(arch === "x86" ? "darwin-x64" : "darwin-arm64");
  }
  return pick(arm ? "linux-arm64" : "linux-x64");
}

export function Download() {
  const [mine, setMine] = useState<Target | null>(null);
  useEffect(() => {
    let live = true;
    void detect().then((t) => live && setMine(t));
    return () => {
      live = false;
    };
  }, []);

  const win = mine?.os === "windows";

  return (
    <div className="wrap page">
      <PageHead
        eyebrow={`version ${VERSION} · ${LATEST.date}`}
        title="Download Mnemo"
        lead={<>Free and open source (Apache-2.0). One archive holds <code>mnemo</code> and its memory sidecar <code>memsrv</code>; no Bun, Node or Rust is needed.</>}
      />

      <section className="dl-hero" aria-labelledby="dl-primary" data-reveal="">
        <div>
          <h2 id="dl-primary" className="label">{mine ? "For your system" : "Pick your system"}</h2>
          {mine ? (
            <>
              <p className="dl-sys"><strong>{mine.name}</strong> · {mine.arch}</p>
              {win ? (
                <>
                  <p>In PowerShell:</p>
                  <Cmd prompt="PS> " text={`irm ${SITE}/install.ps1 | iex`} />
                  <p>
                    Or <a href={url(mine.file)} download>download {mine.file}</a>, unzip it, and double-click <code>mnemo.exe</code>: it installs itself.
                  </p>
                </>
              ) : (
                <p className="cta">
                  <a className="btn primary big" href={url(mine.file)} download>Download for {mine.name}</a>
                  <a className="btn big" href="/install.sh" download>Installer script (install.sh)</a>
                </p>
              )}
              <p className="fine-sm">
                {mine.file} · <a href={url("SHA256SUMS")}>SHA256SUMS</a>
                {win ? <> · <a href="/install.ps1">install.ps1</a> (read before you run)</> : null}
                {mine.os === "mac" ? <> · Intel Mac? <a href={url("mnemo-darwin-x64.tar.gz")}>Download the Intel build</a>.</> : null}
                {mine.os === "linux" ? <> · Not this architecture? See <a href="#all">all downloads</a>.</> : null}
              </p>
            </>
          ) : (
            <>
              <p className="dl-sys">Choose a build below, or use the one-line installer, which picks the right one itself.</p>
              <p className="cta">
                <a className="btn primary big" href="#all">All downloads</a>
                <a className="btn big" href="#install">One-line installer</a>
              </p>
            </>
          )}
        </div>
        {win ? (
          <ol className="steps" aria-label="After you download">
            <li><strong>Run the command, or unzip and double-click <code>mnemo.exe</code>.</strong> <span>Either way <code>mnemo.exe</code> and <code>memsrv.exe</code> go to <code>%USERPROFILE%\.mnemo\bin</code>, on your PATH.</span></li>
            <li><strong>Open a new terminal,</strong> <span>so it sees the new PATH. The unzipped folder can go.</span></li>
            <li><strong>Run <code>mnemo doctor</code>,</strong> <span>then <code>mnemo</code> in a project folder.</span></li>
          </ol>
        ) : (
          <ol className="steps" aria-label="After you download">
            <li><strong>Unpack it.</strong> <span>The archive holds <code>mnemo</code> and <code>memsrv</code>.</span></li>
            <li><strong>Put both on your PATH,</strong> <span>in one folder (for example <code>~/.mnemo/bin</code>).</span></li>
            <li><strong>Run <code>mnemo doctor</code>,</strong> <span>then <code>mnemo</code> in a project folder.</span></li>
          </ol>
        )}
      </section>

      <Install />

      <section id="all" aria-labelledby="all-h" className="block">
        <h2 id="all-h">All downloads</h2>
        <p className="lead-sm">Straight from the <a href={`${REPO}/releases/latest`}>latest GitHub release</a>. The links always point at the newest version.</p>
        <div className="tablewrap">
          <table className="dl-table">
            <thead>
              <tr><th scope="col">System</th><th scope="col">Chip</th><th scope="col">File</th><th scope="col"><span className="visually-hidden">Download</span></th></tr>
            </thead>
            <tbody>
              {TARGETS.map((t) => (
                <tr key={t.id} className={mine?.id === t.id ? "mine" : undefined}>
                  <th scope="row">{t.name}</th>
                  <td>{t.arch}</td>
                  <td className="n">{t.file}</td>
                  <td><a className="btn sm" href={url(t.file)} download aria-label={`Download ${t.file}`}>download</a></td>
                </tr>
              ))}
              <tr>
                <th scope="row">Any</th>
                <td>checksums</td>
                <td className="n">SHA256SUMS</td>
                <td><a className="btn sm" href={url("SHA256SUMS")} download aria-label="Download SHA256SUMS">download</a></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="fine-sm">
          Older versions and release notes: <a href={`${REPO}/releases`}>all releases</a> · <a href="/changelog">changelog</a>.
          The installer scripts: <a href="/install.sh">install.sh</a>, <a href="/install.ps1">install.ps1</a> (read before you run).
        </p>
      </section>

      <section id="verify" aria-labelledby="verify-h" className="block">
        <h2 id="verify-h">Verify what you downloaded</h2>
        <p className="lead-sm">The one-line installers do the checksum for you. If you downloaded an archive by hand, check it.</p>
        <h3>Checksum</h3>
        <p>Catches a corrupted or truncated download. Put the archive and <code>SHA256SUMS</code> in one folder:</p>
        <Cmd text="sha256sum --ignore-missing -c SHA256SUMS" />
        <p className="fine-sm">On macOS use <code>shasum -a 256 -c SHA256SUMS --ignore-missing</code>. On Windows: <code>(Get-FileHash mnemo-windows-x64.zip).Hash</code> and compare it to the line in <code>SHA256SUMS</code>.</p>
        <h3>Provenance</h3>
        <p>Release archives are built by GitHub Actions from the tagged commit and carry a build-provenance attestation. The checksum file is published beside the archive, so it cannot prove the release itself was not replaced; the attestation can.</p>
        <Cmd text={`gh attestation verify mnemo-linux-x64.tar.gz --repo AtmanMishra/Mnemo --source-ref refs/tags/v${VERSION}`} />
      </section>

      <section id="after" aria-labelledby="after-h" className="block">
        <h2 id="after-h">After installing</h2>
        <div className="cards">
          <article className="card"><h3><code>mnemo doctor</code></h3><p>Shows what Mnemo found: model, memory sidecar, Python. <code>--fix</code> repairs what it can.</p></article>
          <article className="card"><h3><code>mnemo --demo</code></h3><p>A scripted session in a scratch project. It needs no API key and shows what a turn looks like.</p></article>
          <article className="card"><h3><code>mnemo</code></h3><p>Start in the current folder. On first run, <code>/login</code> adds a provider and <code>/model</code> picks a model.</p></article>
          <article className="card"><h3><code>mnemo update</code></h3><p>Installs the latest release, checking its SHA-256 first. <a href="/docs#update">More on updating.</a></p></article>
        </div>
        <Note tone="note" title="Requirements">
          macOS (Apple silicon or Intel), Linux (x86-64 or ARM64; built on Ubuntu 22.04 so it runs on older glibc) or Windows x64. A Python 3 on your
          PATH is only needed for the <code>ipy_run</code> tool; everything else works without it. A model provider key or subscription is yours to bring.
        </Note>
        <Note tone="warn" title="Before you point it at code you care about">
          Mnemo reads your files, edits them and runs commands as you. It asks first by default. The permission gate is a filter, not a sandbox: read{" "}
          <a href="/security">security</a> before using <code>--yolo</code> or <code>-p</code>.
        </Note>
        <p className="fine-sm">Installed with Homebrew or Scoop? <a href="/docs#update">See updating</a>. Remove Mnemo with <code>mnemo uninstall</code> (<a href="/docs#uninstall">details</a>).</p>
      </section>
    </div>
  );
}
