# Terminal-Bench subset — Mnemo on DeepSeek v4.1 Flash

*2026-10-08. Runner: `app/eval/tbench.ts`. Model `opencode-go/deepseek-v4.1-flash`.
Mnemo (compiled binary + `memsrv`) runs inside each task's container, headless
(`mnemo -p "<instruction>" --yolo`), within the task's own time limit; the
task's own `run-tests.sh` scores it with Terminal-Bench's pytest rule.*

## What was run, and what was not

- **Tasks**: Terminal-Bench core 0.1.1, single-container, easy and medium,
  built on Terminal-Bench's Ubuntu 24.04 base. That is 17 tasks. The three
  QEMU/kernel builds were left out (they download from kernel.org and run for
  hours). Of the 14 left, the reference solution (the `oracle` arm) solves
  **10** on this machine; the other four were broken by its network
  (`chess-best-move` cannot build; `cron-broken-network`, `fibonacci-server`
  and `git-multibranch` fail with the reference solution) and are excluded
  from both arms.
- **The machine's network** allows only HTTPS through a TLS-inspecting proxy,
  and refuses ghcr.io, Debian mirrors, github.io and astral.sh. So the
  Ubuntu/Python base images were rebuilt from their recorded Dockerfiles, each
  image gets the proxy's CA bundle and https apt mirrors after every `FROM`,
  and `uv` is placed where the tests' installer would put it. Nothing else in a
  task changes.
- **This is a subset, easy and medium only, one attempt per task.** It is not
  comparable to the published leaderboard (all tasks, all difficulties).

## Results (10 oracle-valid tasks, pass@1)

| run | arm | solved | model cost | agent time |
|---|---|---|---|---|
| 1 | no memory | 10/10 | $0.073 | 15.5 min |
| 1 | memory (before the fix below) | 9/10 | $0.111 | 22.7 min |
| 2 | no memory | 10/10 | $0.086 | 17.6 min |
| 2 | memory | 10/10 | $0.072 | 18.4 min |

Solved by both arms in run 2: crack-7z-hash, csv-to-parquet, fix-permissions,
git-workflow-hack, modernize-fortran-build, polyglot-c-py, processing-pipeline,
prove-plus-comm, sqlite-db-truncate, sqlite-with-gcov.

## What it found

**A real memory bug.** In run 1 every task ran in `/app` inside a different
container, and Mnemo's identity for a folder outside git was its path, so all
ten tasks were one project, `dir:/app`. Facts from earlier tasks (a Fortran
build's verify command, a Coq check) were recalled into unrelated ones; on
`polyglot-c-py` the memory arm left a build artifact the tests reject, and lost
a task the memoryless arm solved. The fix (commit 95c2ffc): an identity built
from a path carries the folder's creation time, so a new folder at the same
path is a new project. In run 2 each task was its own project and the memory
arm matched the memoryless one.

## What it says

- DeepSeek v4.1 Flash in Mnemo solves every easy/medium task here that the
  environment allows, at about **$0.007–0.009 per task**.
- Memory makes no accuracy difference on this benchmark, as expected: its
  tasks are unrelated one-shot jobs in fresh containers, which is what memory
  cannot help with. Its cost was within run-to-run noise (run 2: $0.072 vs
  $0.086; the no-memory arm alone varied $0.073–0.086 between runs).
- The benchmark that measures Mnemo's claim is repeated work on the *same*
  project (the learning-curve series in `hermes-comparison.md`, where no
  memory scores 78–87% and memory 99–100%). A public version of that, a
  per-repository chronological split of SWE-bench, is still to do.
- Not measured here: hard tasks, best-of-n and escalation on the benchmark,
  and a frontier agent on the same subset (no frontier API key on this
  machine).
