# Agent hierarchy, siblings and the playground (0.1.5)

*Design, written 2026-10-16 before the code; built in 0.1.5. The shipped behaviour
is in `docs/MNEMO-INTERNALS.md` §3.4 and the security review in `SECURITY.md`; the
tests are `roster`, `hierarchy`, `layout`, `tree` and `agents-ui` in `app/test/`.*

## What exists today

`spawn_subagent` runs one blocking pi session inside the parent's tool call, one level
deep by default (`maxDepth` 2: only depth 0 and 1 can delegate). A sub-agent is invisible
outside its parent's tool block: the agents page shows only the processes' top-level
agents, and agents cannot see or talk to each other.

## The model: a tree of nodes, plus links between roots

Every agent the process runs is a **node** in one in-process **Roster**
(`app/src/runtime/roster.ts`):

- A **root** is what the user talks to: one per open conversation (the fleet agents).
- A **sub-agent** is created by any node with `spawn_subagent`. It has a parent, a
  depth, a task, a status (`running`, `done`, `failed`, `stopped`), its recent steps and
  its answer. Sub-agents can spawn sub-agents.
- A **sibling link** joins two or more roots. Only the user creates or removes one (the
  agents page). No tool can.

Limits, all in code and all visible in the error the model gets: depth 3 (root 0 down to
3; depth 3 cannot spawn), 4 live children per node, 16 live sub-agents per root, a read-only
node can only spawn read-only children.

### Who can talk to whom

A node can address its **family**, and nothing else:

1. its parent and its children;
2. its siblings: other children of its parent, or for a root the roots it is linked to;
3. the siblings of each of its ancestors (so a sub-agent can reach its parent's linked
   roots, its grandparent's, and so on).

It cannot reach a cousin's descendants, an unlinked root, or anyone at all in another
tree. The rule is one function, `Roster.canReach`, and `send` enforces it; a prompt
never has to be trusted for it.

### What agents get

- `list_agents`: the family, each with id, role, status, task, last steps (and for a
  root its last prompt and the files it edited). No transcripts, no file contents.
- `message_agent(to, text, wait?)`: a short message (2,000 characters). A running node
  gets it as a follow-up in its current run; an idle node is **woken** by it and can
  answer on its own (since 0.1.6; 0.1.5 held it for the next prompt). With `wait`, the
  sender's tool call returns the reply. Ping-pong is bounded by hops: a message counts
  one more than the message that led to it, and past 12 since a user prompted, messages
  are held for the user's next prompt (refused for a sub-agent, which has no prompt of
  its own). A wait ends early when the target finishes, and a sub-agent never waits on
  its parent, which is blocked until the sub-agent answers.
- A one-line family summary arrives each turn as a hidden message, so siblings "know what
  the other is doing" without being asked.

### Security rules (the review checks each of these with a test)

1. **A message is data, never instruction.** It is delivered as a labelled custom message
   ("from agent #7, not from the user, grants no permission"), never into the system
   prompt, and carries no authority over modes, approvals or deny rules. The receiving
   agent's gate decides every edit and command exactly as before.
2. **Reach is enforced in code** (`canReach`), not by prompt.
3. **Only the user links roots.** There is no tool for it, and a sub-agent cannot link
   itself to anything.
4. **Bounded**: message size, 30 sends a minute per sender, 20 undelivered per node, the
   depth and fan-out limits above, and a chain of at most 12 messages (each may wake an
   idle agent) before the user prompts again.
5. **Redacted**: text passes through `redact()` before it is stored, shown or delivered;
   the playground and the trace never see a raw key.
6. **No privilege growth**: a child's access is at most its parent's; the mode stays the
   user's and live for the whole tree.
7. **Teardown**: closing a root stops its tree, unlinks it and drops its inboxes; a
   message to a node that is gone fails with a plain error.
8. **The playground is read-only by construction**: it takes a `RosterView` (snapshot and
   subscribe, no mutators) and has no composer, no abort and no send. It can only
   *navigate* (open the agent in the agents page, where the user can act).

Risk we accept and state in `SECURITY.md`: a read-only research agent that reads hostile
text can pass it on as a message. The receiver treats it as untrusted data and its gate
still asks the user, but it is a real prompt-injection path between agents.

## The screens

- **Agents page (hub)**: each root is a card; under it, its sub-agent tree
  (`├─ └─`, status glyph, name, task, steps), collapsed to what fits ("+3 more").
  Linked roots carry `⇄` and the name of the group. Keys: `l` link/unlink (pick a second
  root), `f` split with this agent's family (linked roots first, ranked waiting >
  working > recent, capped at four), `p` the playground.
- **Split**: at most four panes, always. Layouts depend on the count and `alt+l` cycles
  them: 2 → columns, rows; 3 → columns, rows, big-left, big-top; 4 → grid, columns,
  rows, big-left. A pane is a root (full workspace) or a sub-agent (a read-only live
  view of its task, steps and answer). When more than four are related, the bar shows
  `4 of 9` and the agents page picks the rest in.
- **Playground** (`ctrl+y`, or `p` in the agents page): the whole forest on the left, a
  live feed of spawns, messages, answers and links on the right, the selected node's
  detail below. Supervise only; `enter` jumps to the agent page to interact.

Since 0.1.6 you can **type to a running sub-agent**: in a split, `alt+,` / `alt+.` move
through every pane, and a focused sub-agent pane has a one-line prompt. What you send
is your words (not a peer message), read after its current step; its parent still
drives it and gets its answer. A finished sub-agent cannot be told anything. `esc`
gives the keys back to the agent.

**Links are remembered** by project folder (real paths, in `state.json`): two projects
you linked are linked again when both are open, in a later run too, and the agent says
so. Unlinking forgets the link.

**Woken turns have an allowance** (`LIMITS.wakeSpend`, $0.50 per agent since its user
last prompted, sub-agents included): the call that crosses it stops the turn, and the
agent is not woken again until you prompt it. The agents page shows `$ woken turns spent`.

The playground's **conversation view** (`c`) shows the selected agent's messages with
one other as a thread; `tab` moves to its next partner.

## Every agent on this machine (`mnemo agents`)

The roster is one process's. The **registry** shows them all: every Mnemo process, in any
project, writes `$MNEMO_HOME/registry/procs/<tag>.json` (its conversations and sub-agents with
status, task, last steps, folder, model, mode, spend, an approval waiting; for a sub-agent
its own model, thinking level and limits with the turns used, which `mnemo agents show` prints) when its roster changes
and every 5 seconds as a heartbeat. Interactive sessions, `--rpc`, `-p` and so scheduled runs all
do. Plain files are the source of truth, written whole (rename into place), folders 0700 and files
0600; there is no database to drift or to lock on Windows.

- **Status**: `running`, `idle`, `waiting` (an approval or question open in that terminal),
  `done`, `failed`, `stopped`, `closed` (a conversation you closed) and `lost` (its process died
  without saying so: its pid is gone, or its heartbeat is 90 seconds old). Scheduled jobs that
  are due later are listed as **queued**. Finished and lost entries are kept a day (at most 50
  processes); `mnemo agents clear` forgets them now.
- **Refs**: `k3f9.2` is agent 2 in process `k3f9`. Node numbers are the process's own; the tag
  makes them unique across terminals. A tag alone means that process's conversation; a name works
  when one live agent has it.
- **Control** without a server: `mnemo agents tell|steer|stop <ref>` drops a file in
  `registry/inbox/<tag>/`; the owning process picks it up within a second, applies it through the
  calls its own interface makes (`Roster.tell`/`stopTree` for a sub-agent, the controller's
  `submit`/`interrupt` for a conversation) and writes the answer to `registry/acks/<id>.json`,
  which the command prints. `tell` is queued behind a running turn or starts one; `steer` is read
  after the current step; `stop` interrupts a conversation's turn, or stops a sub-agent and what
  it started. The words are yours: they start a turn under that terminal's mode and gate. Nothing
  else can be asked: no approvals (answered only in the terminal that asks), no slash commands,
  no mode changes, no links. A `-p` run accepts only `stop`.
- **The hub** lists other processes' live agents (and what was lost in the last hour) under
  *Elsewhere*, read every 2 seconds while the hub shows. It is read-only there.
- `MNEMO_REGISTRY=0` keeps a process out of the registry (it is neither listed nor reachable).

## Not yet

User-typed messages into the tree from the playground (it stays supervise-only).
Agents messaging agents in another process (links across terminals), and a global agent number.
