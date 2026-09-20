# The prompt for the next session

Paste the block below as the first message of a new session. It is written to be
self-contained: the new session knows nothing of the conversation that produced it.

---

Continue the Mnemo rebuild. Repo `C:/self-evolving-agent`, branch
`rebuild/bun-app` (clean, HEAD `d43f25a`, 202 tests pass, `tsc --noEmit` clean).

Read these three files before doing anything:

    docs/HANDOFF.md          the state of the branch, the conventions, the work list
    docs/PLAN-monorepo.md    the target package layout and the library choice per feature
    AGENTS.md                the repo's own rules

Run it once so you have seen what the user sees:

    cd C:/self-evolving-agent/app && bun bin/mnemo.ts        # then ctrl+d to leave
    bun bin/mnemo.ts doctor                                  # what is on/off here

Your task is **item 2: markdown rendering**, which a previous session attempted
and reverted. Do it in this order, and do not skip step 4:

1. `bun add marked` in `app/`. Use `marked` to **tokenize only** — render to ANSI
   ourselves. Wrapping is where terminal markdown falls apart, so layout is ours:
   blocks are lists of segments (text + style), a line is segments that fit the
   *visible* width, and style is applied per segment, not per character. Reuse
   `width()` and `slice()` from `app/src/theme/theme.ts`; never `.length` on a
   string that may be coloured.
2. Fix the two layout bugs the previous attempt's own tests found: flatten the
   segments into styled words *first*, then fill lines (the failed version measured
   words inside each segment), and make sure no laid-out line exceeds its width.
3. Code blocks are **never reflowed** — a line broken to fit is not the line that
   was written. Cut long lines visibly with `…`.
4. Render markdown **only when the answer is complete** (`AssistantBlock.#done` in
   `app/src/transcript/streaming-block.ts`). A fence opened on one line closes
   forty lines later, so a half-streamed message would flip from prose to a code
   block. Streaming stays plain.
5. Four existing tests change as part of this, and updating them is correct, not
   cheating — they assert the plain renderer: `test/pi.test.ts` (a whole turn lands
   in the transcript), `test/session.test.ts` (each thing the user reads appears
   exactly once), `test/streaming.test.ts` (a streamed answer is painted once, in
   order, never twice). Say in the commit why each assertion changed.

Rules that are not negotiable here:

- `cd app && bun test` must be **202+ pass, 0 fail** and `bun run typecheck` must
  be **0 errors** before you claim anything. Never fix a failing test by deleting
  or weakening it.
- Never leave the branch red. If you cannot finish, revert what you started
  (`git checkout -- <paths>` plus removing any new files you added) and say so
  plainly — a previous session did exactly that twice rather than hand over a bug.
- **Run it like a user after every change.** Every real bug so far came from running
  the binary, never from the suite: a bare first screen, a `/login` that looped, a
  key echoed into the transcript, a notice telling a logged-in reader to log in,
  and a wrapper that had been eating every indentation. For this task that means
  running a real answer containing a heading, a bullet list, **bold**, `inline code`
  and a fenced block, and looking at it.
- Commit with `git commit -F <file>`, staging **explicit paths**. Explain in the
  body *why*, including any failure the change prevents.
- Doc comments say which failure a rule prevents, never what the code does. Follow
  the file you are editing: read the neighbouring comments before writing yours.

Verify at the end with, at minimum, the output of:

    cd C:/self-evolving-agent/app && bun test 2>&1 | tail -3
    bun run typecheck
    printf '/quit\r' | bun bin/mnemo.ts      # still starts and leaves cleanly

Report: what changed, the proof (commands and their real output), and what is still
missing. If the markdown library turns out to be wrong for this — for example it
cannot express something the renderer needs — stop and say so with the evidence
rather than working around it.

---

## Why this shape

Each paragraph is a failure that cost a session: the escape-aware measurement, the
streaming flip, the four tests that encode the old renderer, the reverted attempts,
and the bugs that only a real run exposed. The list of items after this one is in
`docs/HANDOFF.md`; item 3 (code blocks and diffs) follows directly and reuses the
same segment layout.
