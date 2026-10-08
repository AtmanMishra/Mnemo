# Handoff — Mnemo, branch `rebuild/bun-app`

> **2026-10-08:** the task list for the whole rebuild is now `docs/ROADMAP.md`;
> the "work list" below is its Stage 1. One correction to the numbers that follow:
> measured on Bun 1.4.2, `bun test` is 201 pass / 1 fail (`app.test.ts` hardcodes
> `Bun 1.3.14`) — roadmap item 0.1.

Written at the end of a session that landed items 0 and 1 of the feature list and
reverted an attempt at item 2. Everything below was measured, not remembered.

## The state, exactly

    branch      rebuild/bun-app   (38 commits ahead of main)
    HEAD        d43f25a plan: the package table, and what each remaining feature is built on
    tests       202 pass, 0 fail          (`cd app && bun test`)
    types       tsc --noEmit: 0 errors    (`cd app && bun run typecheck`)
    worktree    clean — nothing half-landed, no scratch files

Run it:

    cd C:/self-evolving-agent/app && bun bin/mnemo.ts

    bun bin/mnemo.ts doctor         # what is on/off on this machine
    bun bin/mnemo.ts --dump         # one frame, no agent, no key
    MNEMO_HOME="$LOCALAPPDATA/Temp/mnemo-play" bun bin/mnemo.ts    # scratch home

On this machine `doctor` says: provider `opencode-go` ok · **default model none
chosen** (`/model`) · memory sidecar not found (`cd memory-layer && cargo build
--release --bin memsrv`) · ipy kernel ok · home `C:\Users\AtmanMishra\.mnemo`.

## What exists and works (verified by running it)

    first run      Karkinos in PICO-8 colour, the banner, the numbered way in
    /login         five providers; `/login <p>` asks for the key masked (dots),
                   stores it 0600 in the right schema, never echoes it
    /model         live catalogue from the provider (437 models on OpenRouter),
                   `/model <id>` persists defaultModel, the status bar updates
    a turn         a real pi process behind the prompt (`RpcClient`, spawned)
    the gate       a question renders as a block, keys answer it, `→` records it
    tool calls     ▌ while running → ✓/✗ with the reason on its own line
    line editing   arrows, home/end, history, ^a ^e ^u ^k ^w, insert at the caret
    repainting     a frame identical to the one on screen is never drawn
    colour         PICO-8 256-colour, off when not a tty / NO_COLOR / TERM=dumb

Proof that the editor works, if anyone doubts it:

    printf 'abc\x1b[D\x1b[DX\r\x04' | bun bin/mnemo.ts   →  ▶ aXbc
    printf 'first\rsecond\r\x1b[A\r\x04' | bun bin/mnemo.ts →  ▶ second   (history)

## Conventions this codebase actually holds to

1. **Never leave the branch red.** If a change cannot be finished, revert it and
   say so. Two attempts at the line editor were reverted for exactly this.
2. **Run it like a user before believing it.** Every real bug this session came
   from running the binary, never from the suite: a bare first screen, a `/login`
   that looped, a key echoed into the transcript, a notice telling a logged-in
   reader to log in, a wrapper eating every indentation.
3. **Read files with `read_file`, not grep, when escapes or exact bytes matter.**
   Two sessions were lost to grep rendering `\x1b[D` in a way that no text anchor
   matched.
4. **Commit messages go through a file** (`git commit -F msg.txt`): a heredoc body
   with backticks or `&` is refused or mangled by the shell.
5. **Stage by explicit path**, never `git add -A`.
6. **Doc comments explain *why*, not what.** The code says what; the comment says
   which failure it prevents. This is the house style and it is not decorative —
   every non-obvious rule in the tree exists because it was broken once.
7. **Tests travel with their module and assert behaviour, not prose.** When a
   test fails after a deliberate change, decide whether the *contract* changed:
   if it did, rewrite the assertion and say why in the commit; if it did not, the
   code is wrong.

## The work list, with the next concrete step

    ✓ 0  three stale repaint assertions rewritten
    ✓ 1  frame-diff repaint + line editor (proven above)
    ▢ 2  markdown rendering            ← NEXT, see below
    ▢ 3  code blocks and diffs
    ▢ 4  tool output: capture, truncate, "… 7 more lines" + the key that expands
    ▢ 5  tokens · cost · context % in the status bar (pi reports them; we don't show)
    ▢ 6  sessions: `bun:sqlite`, list + resume
    ▢ 7  slash autocomplete, @file mentions, ctrl+L clear, ctrl+R search, esc interrupt
    ▢    monorepo restructure — `docs/PLAN-monorepo.md` steps 1-9

### Item 2, precisely where it stopped

`marked@18.0.13` is **not** installed (the revert removed it); `bun add marked`
works and resolves. The design decided and worth keeping:

- `marked` **tokenizes only**; we render to ANSI ourselves. Wrapping is where
  every terminal agent's markdown falls apart, so layout must be ours.
- Blocks are lists of *segments* (text + style); a line is segments that fit the
  visible width; style is applied **per segment**, not per character, so
  measurement is exact — reuse `width()`/`slice()` from `src/theme/theme.ts`.
- **Code blocks are never reflowed**: a line broken to fit is not the line that
  was written. Cut long lines visibly (`…`).
- Render markdown **only when the answer is complete** (`AssistantBlock.#done`);
  a fence opened on one line closes forty lines later, so half a message would
  flip from prose to a code block mid-stream.
- `currentPainter()` / `setPainter()` in `src/theme/theme.ts` is the seam the CLI
  sets once; tests keep the colourless default.

Two bugs my own tests found in the layout pass, which is where to start:

1. `layout()` measured words *inside* each segment instead of flattening the
   segments into styled words first and then filling lines. Fix that ordering.
2. The same wrong measurement made a laid-out line exceed its width budget in one
   case ("cells, not characters" test).

Then four behaviour tests change and must be updated **as part of** the change —
they assert plain assistant text today and markdown legitimately changes it:
`test/pi.test.ts` (a whole turn lands in the transcript), `test/session.test.ts`
(each thing the user reads appears exactly once), `test/streaming.test.ts`
(a streamed answer is painted once, in order, never twice).

## If a parallel wave is wanted

Disjoint ownership, no two writers in one file:

    A  item 2 markdown      owns src/markdown/**  + the four test files above
    B  item 5 tokens/cost   owns src/status/**, reads pi session stats
    C  item 6 sessions      owns a new src/sessions/** (bun:sqlite)
    D  item 3 diffs         owns src/diff/** + the transcript's tool block
    E  monorepo step 1-2    owns package.json workspaces + moving src/theme/**,
                            src/brand/** — the restructure touches everything, so
                            it goes *last* or in its own worktree

Rules for whoever dispatches them: repeat the whole ownership map in every brief;
forbid `git add/commit` in a shared worktree (the parent commits after review);
give each child the baseline (202 pass, 0 fail, tsc 0) so none chases a failure it
did not cause; require the exact commands run and their output as proof; and say
explicitly that a failing test is not to be deleted.

## The one thing outside anyone's hands

`~/.mnemo/auth.json` holds an invalid 15-character key for some providers. A turn
will come back as a provider error until it is replaced — `/login <provider>`
re-enters it masked. Nothing else blocks a real reply.
