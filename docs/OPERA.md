# Opera: one conductor, several repositories

*Built 2026-10-28 on the agent core (sub-agent limits, runs, TASK.md/LOG.md, profiles, background
sub-agents). The security review is in `SECURITY.md` (Opera); the tests are `app/test/opera.test.ts`.*

An Opera is a workspace of its own in `~/.mnemo/opera/<name>/`. You attach repositories to it, then
talk to its **conductor**: an agent that plans the work and hands each piece to a **thread**. A
thread is a background sub-agent working in a new git worktree of one repository, on its own
branch. The conductor follows every thread through the Opera's log, steers it, and stops it.

```
mnemo opera new shop --budget 10
mnemo opera add shop ~/code/api                     # a folder of yours (its repository is attached)
mnemo opera add shop https://github.com/acme/web    # cloned into the Opera (https only)
mnemo opera add shop acme/docs --name docs --trust  # owner/repo on GitHub; --trust loads its .agents/
mnemo opera shop                                    # start the conductor (mnemo's options apply: --plan, --model …)
mnemo opera show shop                               # repositories, worktrees, the end of LOG.md
mnemo opera budget shop 20 · mnemo opera remove shop web · mnemo opera
```

## On disk

    ~/.mnemo/opera/<name>/opera.json      repositories and budget; only `mnemo opera` writes it
    ~/.mnemo/opera/<name>/repos/<repo>/   clones
    ~/.mnemo/opera/<name>/worktrees/<repo>-<thread>/   one per thread, branch opera/<name>/<repo>-<thread>
    ~/.mnemo/opera/<name>/LOG.md          one line per thing a thread or the conductor did

Folders are 0700 and files 0600. Removing a repository deletes its clone (never a folder of
yours); worktrees and branches stay until you remove them (`git worktree remove`, `git branch -D`).

## The conductor's tools

- `thread_start(repo, task, name?, access?, profile?, model?, maxTurns?, budget?)`: makes the
  worktree and branch from the repository's HEAD (your checkout and its uncommitted work are not
  touched), then starts a background sub-agent there (`spawn_subagent(background: true)` with the
  worktree as its folder). It returns at once; the thread's answer reaches the conductor as a
  message, which wakes it if it is idle. If the thread cannot start, the worktree and branch go.
- `thread_list(thread?)`: every thread's status, model, turns and spend, branch and what it changed
  (`git diff --shortstat` against where it started, commits, untracked files) and the end of
  LOG.md; for one thread, its task, latest steps or answer, and its own log lines.
- `thread_steer(thread, text)`: an urgent peer message; the thread reads it after its current step.
- `thread_stop(thread, why?)`: stops it and the sub-agents it started; its branch keeps its work.

The conductor's system prompt names the Opera's repositories and these tools. Each thread's says
which repository, worktree and branch it works in, that it commits there when done and does not
push, merge or switch branches, and that the conductor's messages grant no permission.

## Shared context

- **Memory**: every agent of an Opera recalls and stores in the Opera's own project memory, so what
  one thread learns about any repository the others see (Atman's choice, 2026-10-28;
  `Host.memoryCwd`).
- **Plan**: threads started from one of your prompts are one run with the conductor, so they share
  that run's TASK.md and `task_update` (`docs/AGENT-HIERARCHY.md`, a team's plan and log). A later
  prompt starts a new run; LOG.md and memory carry across runs.
- **Record**: LOG.md is written by the program from tool calls and roster events, cleaned and
  redacted, and kept across sessions of the Opera.

## Limits

Each thread has your sub-agent limits (model, turns, budget, output and context), which the
conductor may lower, never raise. Live threads count against `maxChildren` (4 at once by default).
All threads together have the Opera's budget ($5 by default, 0 for none): when their spending
(with their own sub-agents') crosses it, every thread is stopped and `thread_start` refuses until
you raise it. Plan mode refuses `thread_start`.

## Dependencies

Stacked on the agent core drafts, which must merge first, in order: #79 → #81 → #82 → #83 → #85 →
#86 → #87 → #88. It does not need the registry (#80); once that merges, `mnemo agents steer|stop`
reaches Opera threads from any terminal like any sub-agent.

## Not yet

Merging a thread's branch from the conductor (it may run git in a repository only through your
approval, like any command), pruning finished worktrees, and Opera threads in the hub as a group.
