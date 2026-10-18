# Releasing Mnemo

A release is a git tag. Pushing `v0.1.0` builds five archives, tests them,
attests them and publishes a GitHub release; the install one-liners then serve
that release. Nothing else is published by hand.

## What a release contains

| Asset | |
|---|---|
| `mnemo-linux-x64.tar.gz`, `mnemo-linux-arm64.tar.gz` | `mnemo` + `memsrv`, built on Ubuntu 22.04 (older glibc, runs on more distros) |
| `mnemo-darwin-arm64.tar.gz`, `mnemo-darwin-x64.tar.gz` | built natively on Apple Silicon and Intel runners |
| `mnemo-windows-x64.zip` | `mnemo.exe` + `memsrv.exe` |
| `SHA256SUMS` | checked by the installers before anything is installed |
| `install.sh`, `install.ps1` | the same scripts the site serves |
| `mnemo.rb`, `mnemo.json` | Homebrew formula and Scoop manifest, generated from `SHA256SUMS` |

Every archive carries a build-provenance attestation (public repository only):

    gh attestation verify mnemo-linux-x64.tar.gz --repo AtmanMishra/Mnemo \
      --source-ref refs/tags/v0.1.0

`--source-ref` matters: without it a dry-run build from any branch also verifies.
The installers' SHA-256 check catches corrupted and truncated downloads; it does
not protect against a compromised release, because the checksum file is published
beside the archive. The attestation is the provenance check, and the build job
that makes the archives cannot sign anything (a separate job does).

## Cutting a release

1. **Be on a green `main`.** CI (`ci.yml`) must pass there.
2. **Rehearse.** *Actions → release → Run workflow* on `main`, leave `tag`
   empty. That is a dry run (setting `tag` and `publish` instead publishes a tag that
   already exists, if it is on `main`): all five platforms are built, smoke-tested (the
   binary runs a whole scripted turn and finds its sidecar), the one-liner
   installer is run against the archive (install, upgrade, uninstall) and
   attestations are made. Nothing is published; the archives are the run's
   artifacts. Do this whenever the workflow, `build.ts` or the installers change.
3. **Prepare.**

       bun app/scripts/release.ts prepare 0.1.0

   This makes the branch `release/v0.1.0`, sets the version in `app/package.json`,
   `packages/memory/package.json` and `memory-layer/Cargo.toml` (and the lockfile,
   which the release builds with `--locked`), runs the type-check and tests, and
   commits. Open a pull request from it and merge it.
4. **Write the notes.** `docs/releases/v0.1.0.md`, if present, is the release body
   (the workflow uses it as `--notes-file`); otherwise GitHub generates it from the
   merged pull requests. Every release so far has one (see `docs/releases/v0.1.2.md`).
   Also add an entry at the top of `RELEASES` in `web/src/content/changelog.ts`:
   the site's changelog page, Atom feed, footer and download version all read it,
   and `release.ts` does not touch it. Land both in the release pull request (or
   before the tag), and run `cd web && npm run build` to check the site still builds.
5. **Tag.**

       git checkout main && git pull
       bun app/scripts/release.ts tag 0.1.0 --push

   The script refuses unless you are on an up-to-date `main` whose three versions
   match. Pushing the tag is the only step that publishes anything.
6. **Watch it.** The workflow publishes only if the tag names the commit it built
   and that commit is on `main`, and every version field matches the tag exactly
   (`v0.2.0-rc.1` needs `0.2.0-rc.1` in all three). The release is made as a
   draft, the files are attached, and only then is it made public, so a failed
   upload never leaves a half release behind `releases/latest`. Pre-release tags (`v0.2.0-rc.1`) are marked as
   pre-releases and do not update the tap. That check is a safety net against
   mistakes, not access control: anyone who can push a tag can run the workflow
   file at that tag. Access control is the repository setup below.
7. **Check it from a clean machine:**

       curl -fsSL https://github.com/AtmanMishra/Mnemo/releases/latest/download/install.sh | sh
       mnemo doctor && mnemo --demo

A bad release is fixed by a new version, not by moving the tag. If one must be
withdrawn, delete the GitHub release (and mark it so in the next notes); never
re-tag a version people may have installed.

## The VS Code extension

`vscode/` downloads the Mnemo release named by `REQUIRED_VERSION` in `vscode/src/install.ts` (the first
release with `--rpc`, protocol 1) and checks it against that release's `SHA256SUMS`. The extension cannot
work until that release is published, so cut it before publishing a `.vsix`. Bump `REQUIRED_VERSION` only to
a version that exists, when the protocol or the app gains something the panel needs.

## Who can publish (set this up once)

1. **Tags:** *Settings → Rules → Rulesets → New tag ruleset*, target `v*`, restrict
   creation (and updates and deletions) to maintainers.
2. **Environment:** *Settings → Environments → release* (the publish job already
   names it): add required reviewers, limit deployment to the `v*` tags, and move
   `TAP_TOKEN` here from the repository secrets so only that job can read it.
3. **Immutable releases:** *Settings → General → Releases* → enable, so a published
   release's assets cannot be swapped.
4. Branch protection on `main` (required CI, no force pushes); a `CODEOWNERS` entry
   for `.github/` and `app/scripts/get.*` if there is more than one maintainer.

## The install one-liner and the site

`web/` is the project's site (Vite + React, on Vercel at `mnemo.atmanmishra.dev`;
setup, DNS and content are in `docs/WEB.md`). Its build runs
`web/scripts/installers.mjs`, which copies `app/scripts/get.sh` and `get.ps1` to
`/install.sh` and `/install.ps1`, so the site, the release asset and the repository
always carry the same installer. The scripts download from the GitHub release, so
the site only ever serves a few kilobytes of text. Vercel deploys `main` on its own;
a release needs nothing from it except the changelog entry above.

**Obsolete:** `site/` and `.github/workflows/pages.yml` are the earlier GitHub Pages
site. They are kept in the tree but superseded by `web/`; the Pages setup that used
to be described here (Settings → Pages, a CNAME to `atmanmishra.github.io`) should
stay off, because the domain now points at Vercel. Do not rely on them or extend
them.

## Homebrew and Scoop (optional)

The formula and manifest are attached to every release. To make
`brew install` and `scoop install` work:

1. Create two public repositories: `AtmanMishra/homebrew-mnemo` and
   `AtmanMishra/scoop-mnemo`, each with a README and nothing else.
2. Create a fine-grained token with **Contents: read and write** on those two
   repositories only, and save it as the secret `TAP_TOKEN` here.
3. From the next stable release the workflow commits `Formula/mnemo.rb` and
   `bucket/mnemo.json` to them. Users then run:

       brew install atmanmishra/mnemo/mnemo
       scoop bucket add mnemo https://github.com/AtmanMishra/scoop-mnemo && scoop install mnemo

If the step fails the release is unaffected; copy the two files in by hand.

## Pinned actions

Every action is pinned to a commit, with the version in a comment. Dependabot
(`.github/dependabot.yml`) opens a weekly pull request to move them; check that
the new commit is the tag it says before merging.

## Not done yet

- **macOS signing and notarisation.** Archives fetched with `curl` or `brew` run
  without a prompt; one downloaded in a browser is quarantined by Gatekeeper
  until a developer ID certificate signs it. Needs an Apple Developer account.
- **Windows code signing.** SmartScreen may warn on a browser download of
  `mnemo.exe`. The `irm | iex` and Scoop paths avoid it.
- **npm and winget packages.** The installers and the two package managers above
  cover the platforms; an npm wrapper that fetches the binary is a possible
  addition.
