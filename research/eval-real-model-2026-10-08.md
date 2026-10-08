# Memory experiments on a real model — 2026-10-08

Model: `opencode-go/deepseek-v4.1-flash` via OpenCode. Harness: `app/eval/`
(six multi-session scenarios, each run with memory and without). Raw results
stay local (`app/eval/results/`, gitignored); this is what they showed and
what changed because of them.

## Final run (repeat 2, $0.12, 26 min)

| scenario | check | kind | with memory | without |
|---|---|---|---|---|
| convention-carries | later session uses pnpm, not npm/yarn | behaviour | 2/2 | 1/2 |
| convention-carries | later session puts port 4111 in the dev script | behaviour | 0/2 | 0/2 |
| convention-carries | memory holds the package manager | memory | 2/2 | — |
| pitfall-learned | later session runs setup before the first test run | behaviour | **2/2** | **0/2** |
| pitfall-learned | later session never hits the missing-fixtures error | behaviour | **2/2** | **0/2** |
| pitfall-learned | memory holds the fix (a pitfall or a project fact) | memory | 2/2 | — |
| correction-sticks | a new file's export has a JSDoc | behaviour | 2/2 | 2/2 |
| correction-sticks | memory holds the comment rule | memory | 2/2 | — |
| picks-up-the-thread | later session blocks the two domains | behaviour | 2/2 | 1/2 ¹ |
| picks-up-the-thread | memory recorded the open thread | memory | 2/2 | — |
| skill-from-procedure | a skill file was saved | memory | 2/2 | — |
| skill-from-procedure | later release followed the procedure | behaviour | 2/2 | 2/2 |
| projects-stay-apart | the other project's command is not suggested | behaviour | 2/2 | 2/2 |
| projects-stay-apart | memory holds the command for project a only | memory | 2/2 | — |

¹ The one baseline pass read `app/eval/scenarios.ts` — the agent has the
whole filesystem. The harness now flags such runs (an `integrity` check) and
leaves them out of every other tally, and deletes each run's directory so a
later run cannot read an earlier one's memory.

Every memory check passes. The behaviour checks that separate memory from
no memory are pitfall-learned (both), package manager and the open thread.
Three scenarios pass either way because the repository itself shows the
answer (a documented neighbour, a git log of the last release) or the check
is negative (isolation); they guard against regressions, not for gains.
The port check fails either way: the fact is recalled, the model does not
apply it to the script. Left strict on purpose.

## What the real model exposed

| # | finding | fix |
|---|---|---|
| R1 | The reflection call never succeeded on OpenCode: it carried no session id (OpenCode answers 400), and `inBackground` swallowed the error. Memory silently lost session records, fixes and skills. | `completeSimple(..., { sessionId })`; a failed reflection is a visible warning. Test pins both. |
| R2 | `create_skill` always wrote to `~/.mnemo`, never the repository. | `scope: project` (default) writes `.agents/skills/`; `update_skill` finds either. |
| R3 | The model saved "do not add X until next session" as a standing fact and refused to continue later. | Directive, `memory_remember` and the reflection prompt: deferred work is not a fact; open items from last session are agreed next steps. |
| R4 | A recalled pitfall did not stop the model reproducing the failure first. | Directive: a recalled fix comes before the command it is about. pitfall-learned went 0/1 → 2/2. |
| R5 | The model wrote its own `last session` fact over the session record. | The key is reserved; `memory_remember` refuses it. |
| R6 | Reflection stored trivia a glance at the repo shows (empty scripts, README contents). | Reflection prompt excludes it. |
| H1 | Checks judged real behaviour wrongly: `setup.sh && test.sh` in one command, "fewer failed calls" when the model writes `test.sh; echo $?`. | Order within a command line; "never hits the error" instead. |
| H2 | Scenarios the repository gave away (a documented neighbour, a visible `phone` field). | New file for the correction; an open item the code does not reveal. |
| H3 | A stub test script that only echoes "passed" made the model audit it rather than run it. | A real `node --test` suite. |
| H4 | A baseline read the scenario source (see ¹). | `integrity` check, contaminated runs excluded, run directories removed. |

## Still open

- Port 4111: knowledge recalled but not applied to the artifact.
- Notes "Memory noted the failure for next time:" carry no detail in the eval
  report (cosmetic).
- Variance: two repeats per scenario; more are cheap (~$0.06 per full run).
