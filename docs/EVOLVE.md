# Evolve: measuring whether Mnemo gets better

Mnemo learns facts, pitfalls, lessons and skills as you work. Whether any of it makes the next run
better is a question it could not answer until now. `mnemo evolve` is the measurement the rest of
the self-improvement plan stands on: a record of how every run went, a scorecard over time, and
past runs you can replay with their own check as the judge.

Nothing here leaves your machine. Everything lives in `$MNEMO_HOME/evolve/`, written for your user
only (0600), with prompts and commands redacted the way memory is.

## What is recorded

After each prompt (with its verify follow-up, if Mnemo sent the run back to run a check), one line
goes to `evolve/outcomes/<project>.jsonl`, where `<project>` is a hash of the project's identity:

| Field | What it holds |
| --- | --- |
| `verdict` | `passed` or `failed` (the last check after the last change), `unchecked` (changed files, no check after), `no-edits`, `error` (the model call failed), `stopped` |
| `checks` | the check commands after the last change and whether each passed |
| `files` | files changed; from git when the run started from a clean tree, so shell edits count |
| `git` | the commit the run started from and whether the tree was clean |
| `turns`, `cost`, `tokens` | from the model's own usage reports |
| `refusals`, `toolErrors`, `failures` | refused calls, failed calls, and a short signature per failure |
| `correction` | the prompt reads as a correction of the run before (`no, …`, `that's wrong`, `undo`) |
| `surface` | the version of your profiles, skills and model notes in force (see below) |

The verdict comes from commands and exit codes, never from what the model says. A check that hides
its exit status (`npm test; echo "exit=$?"`, `|| true`, `| tail`) counts only when its output states
the status; otherwise it is left out. A shell command that writes files (a redirection, a
here-document, `sed -i`, `mv`, `git apply`, a script on stdin) counts as a change, so a check must
come after it to count.

Only the session you talk to records; a sub-agent's work is part of its parent's run. Turn it off
with `mnemo settings set recordOutcomes false` (or "Record outcomes" in `/settings`).

## The scorecard

`mnemo evolve stats` prints, for this project (or `--all`, or the last `--days N`), something like this (illustrative numbers):

```
                          all           earlier       later
runs                      12            6             6
checked and passed        58%           50%           67%             better
changed, not checked      17%           33%           0%              better
repeated a known failure  17%           33%           0%              better
median turns              7             8             6               better
median cost               $0.0031       $0.0034       $0.0029         better
...
```

The window is split in half, so a trend shows and one bad day does not. "Repeated a known failure"
is the number memory should move: a run that hits a failure an earlier run of the project already
hit. `--json` prints the numbers.

## Task cards

A run becomes a task card in `evolve/tasks/<project>/` when it can be judged again without a model:

- it started from a clean git tree and changed files;
- its last check after the last change passed;
- the prompt stands alone (not a correction, not a two-word "go on"), and the check runs inside the project.

The card keeps the commit, the prompt, the check (a leading `cd` becomes the folder it runs in;
`; echo $?`, `|| true` and `| tail` are dropped), the run's change as a patch, and the test files it
wrote or changed, as they were when the check passed. A card made from a later prompt in the same
session is marked a follow-up: it may lean on what was said before, so replays skip it unless asked.

`mnemo evolve tasks` lists them. The newest 30% are **held out** (from three cards on): a later
improver may look at the rest, and a change is also judged on tasks it was not tuned on.
`mnemo evolve forget <id>` deletes one.

## Replay

`mnemo evolve replay` runs cards again:

1. A fresh git worktree at the card's commit. Dependency folders the project ignores
   (`node_modules`, `.venv`, `venv`) are linked in, as best-of does.
2. The first time, the card itself is tried: with its test files put back the check must **fail** on
   the untouched commit, and **pass** with the original change applied. A card that passes with no
   change is `trivial`; one that fails even with the original change is `broken`. Either is skipped
   from then on.
3. `mnemo -p <prompt>` runs there with a scratch Mnemo home: copies of your settings, keys, skills and
   agent profiles, plus a copy of your memory journal in the `memory` arm and none in `no-memory`.
   What the attempt learns or records stays in the scratch home and is deleted with it.
4. The card's test files are written back over whatever the attempt did to them, and the check runs
   (once more before a fail, as best-of does). A pass needs a change outside the test files and a
   passing check, so rewriting the tests to pass does not count.

```
mnemo evolve replay --arm both --model opencode-go/deepseek-v4.1-flash
mnemo evolve replay --split held-out --card 20261028-092133-xsp6
```

Each attempt's diff and check output are kept in `evolve/replays/<project>/<time>/`, with
`results.jsonl`. Your project's own tree, index and memory are not touched.

### Reading the numbers

One attempt per card on a model that is not deterministic is noise: on the ledger fixture (four
cards, 28 Oct 2026) one card passed without memory and failed with it, and the reason was the
card's tests, not memory. The original run's tests also checked inputs the prompt never asked for
(a rate given as a `Fraction`). Hidden tests can over-specify, as they do in SWE-bench. Compare
arms over many cards and repeats before believing a difference.

## Versions of what shapes the agent

The **surface** is the files of yours that shape how an agent works, and the only files a later
evolve step may propose changes to: agent profiles (`agent/agents/*.md`), your skills
(`agent/skills/…`) and notes for one model (`agent/models/*.md`). Settings, policy, permissions and
credentials are not on it, and neither is the memory journal, which keeps its own history.

At the start of each run Mnemo hashes the surface. A state it has not seen before is kept as a
version under `evolve/surface/<version>/` (0600), and the run's record names the version in force,
so you can see how runs went on each one. Files over 256 KB and dot-files are not kept.

```
mnemo evolve history            versions, oldest first, with runs and passes on each (* = in force)
mnemo evolve diff 3f2a9c        files added (+), removed (-) and changed (~) since that version
mnemo evolve diff 3f2a9c 81bd04 between two versions
mnemo evolve revert 3f2a9c      put the files back as they were; prints the command to undo it
```

Notes for one model go in `agent/models/<model id>.md` (characters a file name cannot hold become
`_`, so `anthropic/claude` is `anthropic_claude.md`). They are added to the system prompt whenever
that model runs, sub-agents included, up to 16 KB. Use them for what one model needs telling and
another does not, such as "edit with the edit tool, not here-documents".

A revert keeps the current state as a version first, so it can itself be reverted. It removes
surface files the version did not have, except ones too large to have been kept.

## Where this goes

This is phases E0, E1 and E3 (versions and revert) of the evolve plan. Next: lessons as an
itemised playbook with helped/hurt counts (E2), a canary that reverts a change automatically when
runs on it get worse, and `mnemo improve` (E4), which will accept a change only when it beats a
same-budget race on held-out cards.
