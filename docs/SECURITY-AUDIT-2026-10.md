# Audit against Mercury Agent's advisories (2026-10-18)

Mercury Agent's October 2026 advisories (see the research write-up in the project
files, `research/mercury-agent-vs-mnemo.md`) are a list of the mistakes a personal
agent makes. This is each class checked against Mnemo at v0.1.6. Line numbers are
`app/` unless a path says otherwise.

## Classes that do not apply, and why

| Mercury problem | Mnemo | Evidence |
|---|---|---|
| A tool sends the host's `GITHUB_TOKEN` to an attacker-chosen host (GHSA-r27w) | No tool makes HTTP requests for the model. The only fetches are the updater's, to a fixed `github.com/<REPO>` URL with no token, and memsrv's opt-in embedding call, which must be `https://` or local. | `src/runtime/update.ts:49,106`; `memory-layer/src/remote.rs:44` |
| Sub-agents bypass shell and file approvals (GHSA-h2c6) | A child is a pi session built with the same extension list, policy gate first, and a live view of the parent's mode. Now covered by a test that a full child's command asks the user. | `src/extensions/index.ts:20`; `src/extensions/agents.ts:65`; `test/hierarchy.test.ts` |
| Sub-agent `allowedTools` not enforced (GHSA-qjx7) | Enforced twice: the roster refuses a full child of a read-only parent, and pi gets the tool list as an allowlist, so a read-only child has no `bash` or `write` even in yolo. Now covered by a test. | `src/runtime/roster.ts:294`; `src/extensions/agents.ts:89` |
| "Ask Me" auto-approval bypass by redirection, `find` flags, expansion (GHSA-xc4h, hj5j, gc84) | Mnemo has no read-only command allowlist to bypass: a command asks unless the user granted it. A grant ends on a word, never covers a line containing `; & \| > < ` $ ( ) { }` or a newline, and not `find`, `sed`, `awk`, `xargs` and friends except exactly. | `src/policy/gate.ts:56,145,211`; `test/gate.test.ts`, `test/policy.test.ts` |
| Shell injection in git helpers | Every git call passes an argument array with constant arguments (no shell). The one `sh -c` is `/bestof`'s check command, which the user typed. The Windows PATH edit passes the value through the environment and `-EncodedCommand`. | `src/runtime/best-of.ts:62,79`; `packages/memory/src/project.ts:32`; `src/runtime/self-install.ts:173` |
| A default web password; a web dashboard | There is no server and no listening port. | no `Bun.serve`/`listen` in `src/` |
| "Allow All" pre-selected in the prompt | The approval dialog opens on "Yes" (once). "Don't ask again" is a second row and is not offered for a compound command or a path. yolo is never the default and cannot be set from a file or by the model. | `src/ui/components/Dialogs.tsx:206`; `src/runtime/settings.ts:13` |
| Cloud routing chosen by default | Calls go to the user's own provider only; no Mnemo-run relay. | `SECURITY.md` "What leaves your machine" |
| Telemetry | None; measured, see `SECURITY.md`. | |

## Found and fixed in this change

1. **A grant could become the whole program.** Approving `git --version` with "always"
   saved `git*`, which then allowed `git push --force`. The same for `npm -v`, `make`,
   `cargo --version` and `docker --version`. `git -C dir status` saved the junk
   pattern `git dir*`. A subcommand program with no subcommand, or an option in front
   of it, is now approved exactly (`src/policy/gate.ts`).
2. **The skill approval did not show the skill's description.** The description is
   loaded into every later prompt, so it is the part worth injecting; the dialog showed
   only the scope and the instructions. It now shows the description on one line
   (`src/extensions/policy.ts`).
3. Two regression tests for sub-agents (above).

## Larger, with a recommendation

1. **`GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`, `AWS_*` and similar still reach the bash
   tool and the Python kernel** (`src/runtime/env.ts` strips model-provider keys only;
   `SECURITY.md` says so). This is the closest thing to Mercury's critical advisory:
   a prompt injection plus a permissive mode can send them anywhere. Recommend: strip
   the well-known forge and package-registry tokens too (`GITHUB_TOKEN`, `GH_TOKEN`,
   `GITLAB_TOKEN`, `NPM_TOKEN`, `PYPI_TOKEN`, `CARGO_REGISTRY_TOKEN`) with the existing
   `MNEMO_PASS_ENV` escape. It will break a user who relies on `gh` or `git push`
   through the agent, so it is a decision, not a drive-by.
2. **Headless `mnemo -p` allows every call that would ask** (`src/extensions/policy.ts:474`)
   and `/bestof` candidates run that way. Documented, and `/bestof` confirms first, but
   the confirm defaults to Yes (`src/ui/components/Dialogs.tsx:132`). Recommend: `-p`
   answers "ask" with a refusal unless `--accept-edits` or `--yolo` is given, and the
   `/bestof` confirm defaults to No.
3. **The update path trusts one origin.** `SHA256SUMS` and the archive come from the
   same release, and `mnemo update` runs the release's own `install.sh`/`install.ps1`
   (`src/runtime/update.ts:106-113`, `-ExecutionPolicy Bypass` on Windows). A stolen
   release token replaces both. Recommend: sign the checksums (minisign or cosign) and
   have the installers verify against a key built into the binary.
4. **yolo reads secrets through bash.** Already documented (`docs/REVIEW-2026-10.md`,
   `SECURITY.md`); the read tools refuse credentials, a shell `cat` does not.
   Recommend a default deny rule set offered at first run for `env`, `printenv`,
   `/proc/*/environ` and `curl`/`wget`, rather than leaving it to the user's reading.
5. **memsrv receives `AWS_BEARER_TOKEN_BEDROCK` and any provider key whose name does
   not end in `_API_KEY`/`_TOKEN`/`_SECRET`** (`packages/memory/src/service.ts:144`). It
   does not use them. Recommend giving it an allowlist (`PATH`, `HOME`, `MNEMO_*`)
   instead of a blocklist.
6. **Windows `openBrowser` expands `%VAR%` in a URL** passed to `cmd /c start`
   (`src/ui/link.ts:49`). The URLs are the provider's login URLs, so this needs a
   hostile provider; recommend opening them with `rundll32 url.dll,FileProtocolHandler`
   or PowerShell `Start-Process` instead.

## Mercury's good ideas, and whether to take them

- **Plain persona file the user owns** (`soul.md`/`persona.md`). Worth it and cheap:
  one markdown file in `$MNEMO_HOME`, injected like a profile, shown by `/memory`.
- **Daily cost cap.** Worth it. Mnemo already counts cost per turn (`roster.spend`,
  `/cost`); a `dailyBudget` setting that refuses the next prompt past the cap, with
  a one-keystroke override, is a small change on top of that.
- **Simple permission modes.** Mnemo already has them (default, accept-edits, plan,
  yolo) and they are better named than Mercury's two. Nothing to add.
- **Not worth copying:** persistent bots, a kanban board, chat channels, a web
  dashboard. Each adds a network surface Mnemo's invariants rule out.
