# Memory experiments

Does memory make the *next* session better? Each scenario is a small git
project, a few sessions a person would plausibly have, and deterministic
checks — no model judges a model. Every scenario runs **with memory and
without** (the baseline), so a behaviour check that passes either way is not
credited to memory.

## Run

```bash
cd app
cargo build --release --bin memsrv --manifest-path ../memory-layer/Cargo.toml   # once
bun eval/run.ts                                   # all scenarios, memory + baseline
bun eval/run.ts --scenario pitfall-learned        # one scenario
bun eval/run.ts --repeat 3                        # repeat, to see variance
bun eval/run.ts --model opencode/deepseek-v4.1-flash
bun eval/run.ts --faux                            # the harness only, no model
```

The default model is `opencode-go/deepseek-v4.1-flash` (override with
`--model` or `MNEMO_EVAL_MODEL`). It needs `OPENCODE_API_KEY` in the
environment and `opencode.ai` reachable. Results go to
`eval/results/<timestamp>/` — `report.md` (the table, every failure with its
evidence, what memory showed per session) and `results.json` (every
session's prompts, answers, tool calls, tokens and cost).

Sessions run in `yolo` mode (no approval prompts); dialogs that still open —
saving a skill — are answered yes and recorded.

## Scenarios

| scenario | the claim | behaviour check (later session) | memory check |
|---|---|---|---|
| `convention-carries` | a convention stated once is followed later | uses pnpm, dev script on port 4111 | profile has the package manager |
| `pitfall-learned` | a failure fixed once is avoided next time | runs setup before the first test run; never sees the error | the fix, as a pitfall or a project fact |
| `correction-sticks` | a mid-session correction holds | a new file's export has a JSDoc | the comment rule is in a profile |
| `picks-up-the-thread` | open work resumes from "where were we?" | the two blocked domains are implemented | "last session" mentions them |
| `skill-from-procedure` | a procedure asked to be remembered becomes a skill | the second release is 0.1.2, logged and committed | a skill file under `.agents/skills/` |
| `projects-stay-apart` | one repo's memory stays out of another | project b never hears of `ship-alpha` | the fact is in project a only |

`test/eval.test.ts` proves the checks discriminate: a scripted agent that
uses memory only when memory is in its prompt passes `pitfall-learned` with
memory and fails it without.

| `checks-its-work` | a change is checked before it is called done | tests run after the last edit; hidden tests on old and new behaviour pass | — |

## The learning curve (`series.ts`)

```bash
bun eval/series.ts                                           # baseline vs memory, six tasks
bun eval/series.ts --teacher opencode-go/deepseek-v4-pro     # + teacher→student
bun eval/series.ts --repeat 3 --modes memory,teacher --teacher <provider/id>
```

One small money library ("till") with rules nobody writes down — integer
cents, every function exported from the index, a changelog line per change —
and a build step (`npm run gen`) a fresh checkout lacks. Only the first task
states the rules. Six tasks in a row, each scored by hidden tests written at
check time and deleted after (5 points: the feature, every earlier feature,
integer cents, a changelog line, no build error). `teacher` runs the first
three tasks on the teacher model and the last three on the student, with one
memory: what the stronger model learned is what the cheap one uses.
`test/series.test.ts` proves the scoring: a reference solution scores 5/5 on
every task, and each rule is lost on its own.

## Adding a scenario

Add an entry to `SCENARIOS` in `scenarios.ts`: projects (a setup function per
directory), sessions (project + prompts, optional `before` to change the world
between sessions), and checks that read files, git, the transcript or memory.
A check returns `true` or a string with the evidence of failure.
