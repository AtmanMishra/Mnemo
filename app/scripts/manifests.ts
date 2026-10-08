/**
 * Package-manager manifests for a release, generated from its SHA256SUMS so the
 * hashes can never drift from the archives that were actually published.
 *
 *   bun app/scripts/manifests.ts v0.1.0 dist     writes dist/mnemo.rb (Homebrew)
 *                                                and dist/mnemo.json (Scoop)
 *
 * The release workflow attaches both to the release; a tap or bucket repo can
 * copy them in (docs/RELEASING.md). Each archive holds `mnemo` and `memsrv` side
 * by side, which is where mnemo looks for its memory sidecar, so the formula and
 * the manifest install the two together.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const REPO = "AtmanMishra/mnemo";
const HOME = `https://github.com/${REPO}`;
const DESCRIPTION = "A terminal coding agent with a memory that learns";

/** `{ "mnemo-linux-x64.tar.gz": "<sha256>" }` from the text of a SHA256SUMS file. */
export function parseSums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
    if (m) out[m[2]!] = m[1]!.toLowerCase();
  }
  return out;
}

function need(sums: Record<string, string>, archive: string): string {
  const hash = sums[archive];
  if (!hash) throw new Error(`${archive} is not in SHA256SUMS`);
  return hash;
}

const download = (tag: string, archive: string) => `${HOME}/releases/download/${tag}/${archive}`;

/** The Homebrew formula for `tag` (a `v`-prefixed version). */
export function formula(tag: string, sums: Record<string, string>): string {
  const version = tag.replace(/^v/, "");
  const block = (platform: string) => {
    const archive = `mnemo-${platform}.tar.gz`;
    return `url "${download(tag, archive)}"\n      sha256 "${need(sums, archive)}"`;
  };
  return `class Mnemo < Formula
  desc "${DESCRIPTION}"
  homepage "${HOME}"
  version "${version}"
  license "Apache-2.0"

  on_macos do
    on_arm do
      ${block("darwin-arm64")}
    end
    on_intel do
      ${block("darwin-x64")}
    end
  end

  on_linux do
    on_arm do
      ${block("linux-arm64")}
    end
    on_intel do
      ${block("linux-x64")}
    end
  end

  def install
    # mnemo looks for memsrv, its memory sidecar, next to itself.
    bin.install "mnemo", "memsrv"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/mnemo --version")
  end
end
`;
}

/** The Scoop manifest for `tag`. */
export function scoop(tag: string, sums: Record<string, string>): string {
  const version = tag.replace(/^v/, "");
  const archive = "mnemo-windows-x64.zip";
  return `${JSON.stringify(
    {
      version,
      description: DESCRIPTION,
      homepage: HOME,
      license: "Apache-2.0",
      architecture: { "64bit": { url: download(tag, archive), hash: need(sums, archive) } },
      // memsrv.exe is not put on the PATH: it only has to sit beside mnemo.exe.
      bin: ["mnemo.exe"],
      checkver: "github",
      autoupdate: { architecture: { "64bit": { url: `${HOME}/releases/download/v$version/${archive}` } } },
    },
    null,
    2,
  )}\n`;
}

if (import.meta.main) {
  const [tag, dir] = process.argv.slice(2);
  if (!tag || !dir || !/^v\d+\.\d+\.\d+/.test(tag)) {
    console.error("usage: bun app/scripts/manifests.ts v<version> <dir holding SHA256SUMS>");
    process.exit(2);
  }
  const sums = parseSums(fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8"));
  fs.writeFileSync(path.join(dir, "mnemo.rb"), formula(tag, sums));
  fs.writeFileSync(path.join(dir, "mnemo.json"), scoop(tag, sums));
  console.log(`wrote ${path.join(dir, "mnemo.rb")} and ${path.join(dir, "mnemo.json")}`);
}
