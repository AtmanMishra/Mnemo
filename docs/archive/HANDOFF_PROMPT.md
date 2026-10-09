You are picking up an existing project called MNEMO cold. Read these two files
FIRST, in this exact order, before doing anything else:

1. ~/self-evolving-agent/HANDOFF.md   <- full onboarding doc
2. ~/self-evolving-agent/plan.md       <- the live task tracker

Then confirm you understand by telling me: (a) what Mnemo is in one sentence,
(b) the 4 codebases and what each owns, (c) current test totals, (d) what Area
you'd start with and why.

After I confirm, your task is: **Area 3 — Brain-area memory** (research/brain-areas-design.md).
Start with 3.1: add an `area` field to the Node type in memory-layer/src/model.rs
(default derived from NodeKind per the table in the design doc), thread it through
StoreData/journal ops, and get memsrv to persist+return it. Write tests before
declaring it done. Run `cargo test` in memory-layer/ (must show more than the
current 19 passing, zero failing) and update plan.md's checkbox + STATUS.md with
a short outcome note when you finish, exactly like the existing entries.

Ground rules (also in HANDOFF.md section 6 - read it, these are hard-won):
- Never hardcode API keys anywhere, ever. Check `git diff --cached | grep sk-`
  before every push.
- Thread test-provided temp paths through every function in a call chain -
  a forgotten `home`/`root` param has caused real bugs here before.
- Verify your own "done" claims by actually running the test suite, not by
  reading the code and assuming it's right.
- Keep memory-layer/, harness-engine/, agent/, and tui/ test suites green at
  all times; if you touch shared code, run all four suites.

Work in small, tested increments and push to git after each one that's green
(repo: https://github.com/AtmanMishra/self-evolving-agent, HEAD 31c3c08 as of
this handoff). Do not wait for me between sub-steps - keep going through 3.1,
3.2, 3.3 etc. per plan.md, reporting progress as you land each one.
