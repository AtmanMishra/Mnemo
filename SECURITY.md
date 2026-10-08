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

**The gate filters what runs; it is not a sandbox.** It stops the agent from
running things you did not approve, but anything you approve runs with your
permissions. In headless mode (`mnemo -p`) there is nobody to ask, so every
call that would ask is **allowed**: it behaves like `yolo`, and only `deny`
rules still apply. Run `-p`, `--yolo` and best-of (`--best-of`, `/bestof`) only
in a place you can afford to lose: a container, a throwaway checkout.

## What leaves your machine

- **Your prompts, the files and command output the model reads, and your
  memory's recalled facts go to the model provider you configured.** That is
  how an agent works. Choose the provider accordingly.
- **Nothing else.** Mnemo has no telemetry and no update checks. We measured
  it: `--version`, `doctor`, `--demo` and `memory status` open no network
  connection at all; only a real prompt does, and only to your provider.
- Memory is stored locally under `$MNEMO_HOME` (default `~/.mnemo`) in a
  journal file. It is never uploaded by Mnemo.

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
`/forget` retires a fact. This is a defence in depth, not a guarantee.

## Verifying a download

Each release ships `SHA256SUMS`; the install scripts check it before
installing. Release archives are built by GitHub Actions from the tagged
commit and carry a build-provenance attestation:

    gh attestation verify mnemo-linux-x64.tar.gz --repo AtmanMishra/mnemo
