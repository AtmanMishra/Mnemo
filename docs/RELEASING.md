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

    gh attestation verify mnemo-linux-x64.tar.gz --repo AtmanMishra/Mnemo

## Cutting a release

1. **Be on a green `main`.** CI (`ci.yml`) must pass there.
2. **Rehearse.** *Actions → release → Run workflow* on `main`, leave `tag`
   empty. That is a dry run: all five platforms are built, smoke-tested (the
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
4. **Write the notes (optional).** `docs/releases/v0.1.0.md`, if present, is the
   release body; otherwise GitHub generates it from the merged pull requests.
5. **Tag.**

       git checkout main && git pull
       bun app/scripts/release.ts tag 0.1.0 --push

   The script refuses unless you are on an up-to-date `main` whose three versions
   match. Pushing the tag is the only step that publishes anything.
6. **Watch it.** The workflow publishes only if the tag is on `main`. Pre-release
   tags (`v0.2.0-rc.1`) are marked as pre-releases and do not update the tap.
7. **Check it from a clean machine:**

       curl -fsSL https://github.com/AtmanMishra/Mnemo/releases/latest/download/install.sh | sh
       mnemo doctor && mnemo --demo

A bad release is fixed by a new version, not by moving the tag. If one must be
withdrawn, delete the GitHub release (and mark it so in the next notes); never
re-tag a version people may have installed.

## The install one-liner and the site

`site/` is the project's page; `pages.yml` publishes it with GitHub Pages and
copies `app/scripts/get.sh` and `get.ps1` into it as `install.sh` and
`install.ps1`, so the page, the release asset and the repository always carry
the same installer. The scripts download from the GitHub release, so the site
only ever serves a few kilobytes of text.

One-time setup:

1. Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Custom domain** (same page): enter your domain and tick *Enforce HTTPS* once
   the certificate is issued. DNS at your registrar:
   - a subdomain such as `get.example.com`: one `CNAME` record to `atmanmishra.github.io`
   - an apex domain: four `A` records to `185.199.108.153`, `185.199.109.153`,
     `185.199.110.153`, `185.199.111.153` (and, for IPv6, the four `AAAA` records
     in GitHub's documentation)
3. Nothing in the repository names the domain: the page builds its one-liner
   from the address it is served from. Once it works, put the short one-liner
   in the README.

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
