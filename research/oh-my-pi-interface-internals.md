# How oh-my-pi's interface is built — and what that means for ours

A read of `C:\Users\AtmanMishra\oh-my-pi` (MIT, Stencil Labs), from the rendering
core to the onboarding wizard, with the file:line where each claim comes from.
Written to be used: the last section is what we inherit, what we must build, and
what to leave alone.

## 0. The lineage, which changes everything

**oh-my-pi's TUI is a fork of the same pi interface we already depend on.**
`packages/tui/` is its own copy — 125,989 lines across that package — but the
component vocabulary is shared with upstream pi: `dist/modes/interactive/
components/` in our own `node_modules/@earendil-works/pi-coding-agent` ships
`assistant-message`, `bash-execution`, `bordered-loader`, `config-selector`,
`compaction-summary-message`, `branch-summary-message` — the same names we find
in their `packages/tui/src/chat/` and `chrome/`.

Consequence for the plan: **we do not port the TUI.** The components arrive by
depending on pi, exactly as oh-my-pi's do. What differs — and therefore what
this document is actually about — is the ~40k lines of *app* they wrote on top:
the transcript container, the block lifecycle, the setup wizard, the status
line, the symbol presets. Those are the parts worth learning from, and the parts
we would otherwise reinvent badly.

---

## 1. The rendering core (`packages/tui/src/tui.ts`, 3,615 lines)

**Two output channels, one writer.** The file's own summary (tui.ts:1-13): a
frame provider returns, per frame, an optional **immutable `HistoryBatch`**
(rows finalized into native scrollback, gated by a monotonic id and
acknowledgement) plus the **complete mutable viewport**. The writer anchors the
viewport directly below whatever history remains visible, diffs
**viewport-only** frames, and — the sentence that matters — *"never infers
finality from a row's position."*

Where our interface has struggled, this is the answer: a row is either history
(never touched again) or live (redrawn every frame), and the boundary is decided
by the producer, not guessed from where the row appears on screen. Destructive
clears (`ED3`) happen only through explicit user gestures or configured rebuilds
(tui.ts:10-12).

**The Component contract is deliberately tiny** (tui.ts:221-252):

```ts
interface Component {
  render(width: number): readonly string[];   // physical rows; may return the SAME array when unchanged
  handleInput?(data: string): void;           // only while focused
  wantsKeyRelease?: boolean;                  // Kitty protocol
  invalidate?(): void;
  debugId?, debugKind?, debugState?(), debugChildren?   // a live debug tree
}
```

`render` returning *the same array reference* when nothing changed is what makes
the diff cheap — the framework compares identity, not strings.

**Paint framing is explicit and defensive** (tui.ts:80-96): each paint emits
`HIDE_CURSOR` + `SYNC_OUTPUT_BEGIN` (`\x1b[?2026h`, DEC 2026 synchronized
output) + `DISABLE_AUTOWRAP`, and ends by restoring autowrap and ending the sync
block. Autowrap is disabled because several terminals keep a "pending wrap" flag
after an exact-width row, which turns a following cursor move into a staircase
trail (tui.ts:72-79). Every content row ends with a terminator that closes both
SGR state and any OSC 8 hyperlink, so styles and links cannot bleed into
scrollback (tui.ts:55-63).

Mouse tracking is scoped, not global (tui.ts:89-96): `off | inline | full`, with
1000h/1003h/1006h enabled only for overlays that opt into pointer interaction —
so the terminal keeps native text selection everywhere else. That is the same
trade-off our Go interface punted on.

---

## 2. The transcript and the chat interface

### 2.1 Block lifecycle (`chrome/transcript-container.ts`, 902 lines)

Three states, named (transcript-container.ts:58-64):

    active     still mutating; renders live, counts against tool admission
    settled    finalized, retained in the mutable viewport until pressure
    committed  logically retired; a replay never rewinds this state

And two modes per block (transcript-container.ts:17): `"mutable"` or
`"appendOnly"`. An append-only block must satisfy a **contract**

    getTranscriptStableRows(): readonly { key: string }[]
    renderTranscriptStableRows(count, width): readonly string[]
    resetTranscriptStableRows?()

where every later publication extends the previous keys **exactly**, and
rendering the first `count` rows must prefix the full render at that width
(transcript-container.ts:24-50). That is what lets an assistant answer *retire
into native scrollback mid-stream*: the head is already in history, only the
tail keeps repainting. A publication that breaks the contract (their example: a
mid-stream theme change) **freezes further stable-row emission for that block
instead of failing the render**.

Caches are keyed on both dimensions — `Map<width, Map<snapshotCount, rowCount>>`
(transcript-container.ts:72-78) — because one markdown snapshot commonly wraps to
several physical rows.

### 2.2 The block primitive (`chrome/chat-block.ts`, 110 lines)

`ChatBlock` is React-shaped: `onMount()`, `onCleanup(fn)`, `requestRender()`,
`finish()` (self-complete: stop animating, keep the final frame),
`dispose()` (host discards it), and it reports `isTranscriptBlockFinalized()`
so the container knows whether the block may still repaint
(chat-block.ts:11-27). Producers *return a block*; they never poke the
container or the TUI directly, and a block can only reach the host through
`ChatBlockHost { requestRender() }` — "kept minimal so blocks never reach into
the full TUI surface" (chat-block.ts:5-9).

### 2.3 From model message to screen

`addMessageToChat` is a `switch (message.role)` that constructs the component per
kind — `bashExecution`, `pythonExecution`, `hookMessage`/`custom` (with
sub-dispatch on `customType`, e.g. an async-result card, a late-diagnostics
card), assistant, user, tool groups
(`modes/utils/ui-helpers.ts:154+`). Every renderer is a component; there is no
formatting in the event path.

For a transcript with **no live session** (a parked subagent, an advisor, a
collab guest), `chat/chat-transcript-builder.ts` rebuilds the whole thing from
persisted entries, discarding prior components every time. The comment states
the trade explicitly: O(n) re-render, "but it cannot duplicate or misorder rows
the way incremental component reuse could" (chat-transcript-builder.ts:9-14).
That is a design decision we will want to copy verbatim for any replay path.

### 2.4 The message components

- **`chat/assistant-message.ts` (1,214)** — markdown (a `Markdown` component
  with a themed `MarkdownTheme`), images with an `ImageBudget`, thinking blocks
  with a formatting pass, plus three annotations a plain renderer would miss: a
  **cache-invalidation marker** (which turn broke the prompt cache), a
  **served-model mismatch marker** (the provider answered with a different model
  than asked), and a bounded provider-error block —
  `MAX_TRANSCRIPT_ERROR_ROWS = 8`, "bounds pathological error bodies — e.g. a
  proxy 502 whose body is a full HTML page — so they can't flood the scrollback,
  while a long single-line body wraps to the width instead of being cut"
  (assistant-message.ts:24-31).
- **`chat/tool-execution.ts` (1,395)** — tools render through a **registry**
  (`toolRenderers` from `../tools/index`), with a `SafeToolRendererComponent`
  wrapper that keeps a failing renderer from taking down the transcript. It
  knows about per-tool preview lines (`BASH_DEFAULT_PREVIEW_LINES`), diffs
  (`renderDiff`, per-file `PerFileDiffPreview`), images from tool details, and
  a streaming fallback. Two tools are "displaceable" — `todo` and `hub` — and
  move out of the flow into their own surface when they complete
  (tool-execution.ts:64-73).
- **`chat/read-tool-group.ts`** — consecutive reads collapse into one group
  (`groupedReadUsageCallIds`), the same instinct we had with "an agent that
  reads six files should say so once".
- Siblings for bash execution, python/eval execution, compaction summaries,
  branch summaries, skills, todo reminders, reactions, extension messages —
  every kind of event a session produces has a component with its own file.

### 2.5 Streaming: two mechanisms, both deliberate

**Reveal** (`modes/controllers/streaming-reveal.ts`) — the text is revealed at a
bounded cadence rather than dumped on arrival: `STREAMING_REVEAL_FRAME_MS =
1000/30`, `MIN_STEP = 3` graphemes, `CATCHUP_FRAMES = 8`, grapheme-aware
slicing with an LRU cache of counts. Its comment carries the cost of doing it
naively: *"a full tree walk here at 30fps costs 5% of CPU on its own and drives
the Box/Container overhead that cascades into another ~15% — see issue #4377"` —
which is why the reveal calls `requestRender(component)` scoped to **the
subtree that changed** rather than the tree (streaming-reveal.ts:20-27).

**Thinking** (`chat/assistant-message.ts`) — while the model is thinking, a
single fixed-width starburst cycles `✻ ✼ ❉ ❊ ✺ ✹ ✸ ✶`, and the per-frame dwell
eases between a min and a max on a raised-cosine "breath" so it accelerates and
slows instead of ticking (assistant-message.ts:77-90). Fixed width is the
point: the line never shifts the trailing speed badge.

---

## 3. Onboarding

### 3.1 The scene contract (`setup/scenes/types.ts`)

```ts
interface SetupScene {
  id: string;
  title: string;
  minVersion: number;                                  // per-scene version gate
  shouldRun?(ctx: SetupHost): boolean | Promise<boolean>;
  mount(host: SetupSceneHost): SetupSceneController;
}

interface SetupSceneController extends Component {
  title: string; subtitle?: string;
  onMount?(): void | Promise<void>;
  onUnmount?(): void;
  dispose?(): void;
  render(width, maxLines?): readonly string[];         // body row budget, not the whole screen
  routeMouse?(event, line, col): void;
}
```

`SetupHost` (types.ts:19-44) is the application's own surface — `saveTheme`,
`saveComposerShape`, `selectModel`, `refreshModels`, `markComplete`,
`playWelcomeIntro`, `showError`, `copyToClipboard`, `openInBrowser`. The wizard
owns presentation; the app owns effects. A scene renders into a **row budget**
the wizard computes (`maxLines`), and is told so: it shrinks lists and drops
decoration to keep the selection visible (types.ts:65-71).

Tabs exist for scenes that need them: `SetupTab { id, label, modal, render,
handleInput, onActivate, dispose }` — `modal` means "an OAuth login is in
flight; do not let the parent switch tabs or finish" (types.ts:85-102). The
providers scene is exactly that: SignIn + WebSearch behind a TabBar
(`scenes/providers.ts:14-33`), with mouse hit-testing for the tab row and wheel
routed to the panel (providers.ts:65-87).

### 3.2 The wizard (`setup/wizard-overlay.ts`, 319 lines)

Phases: `splash → transition → scene → outro → done` (wizard-overlay.ts:14).

- **Splash** — a generated scene, not an asset: `SETUP_SPLASH_MS = 2600`, a
  33 ms tick, the brand mark at 2x out of a **rippling water surface** built
  from three interfering sine waves with radial falloff and a vertical fade,
  under a hashed starfield, sharing one continuous diagonal gradient with the
  mark so the shine sweeps across the whole scene
  (`scenes/splash.ts:80-119`). Below 56×22 it degrades to a centered mark
  (splash.ts:21-24).
- **Transition** — a top-biased cross-dissolve, `SCENE_TRANSITION_MS = 420`:
  each row flips once it crosses its own threshold, top rows first, with a
  per-row hash "for an organic edge", eased with smoothstep
  (wizard-overlay.ts:25-46).
- **Scene frame** — logo, app name, `Setup step N of M`, title, optional
  subtitle, body clipped to the remaining rows, and a footer of hints:
  `↑/↓ select · enter confirm · esc skip · ctrl+c exit setup`
  (wizard-overlay.ts:183-215).
- **Lifecycle discipline** — one interval drives the animation and is cleared
  on dispose; scenes get `onMount`/`onUnmount`/`dispose`; focus is handed to the
  scene and restored to the wizard; `#complete()` resolves the promise exactly
  once (wizard-overlay.ts:225-318).

### 3.3 Which scenes run (`setup/wizard.ts`)

`ALL_SCENES = [providers, model, glyph, composer, theme]` (wizard.ts:17-23) —
note what the list is: **it introduces the tool and configures taste**, in order,
with the provider question first. Selection is a gate, not a default
(wizard.ts:41-65): no TTY → nothing; resuming a session → nothing;
`OMP_SKIP_SETUP` set → nothing; the setting disabled → nothing; `minVersion` not
newer than the stored version → nothing; and a scene may add its own
`shouldRun`. Completion is written **once, after the wizard finishes**
(`markSetupWizardComplete`, modes/setup.ts:95-98), so an interrupted wizard is
asked again rather than half-remembered. A separate provider wizard exists for
later (`runProviderSetupWizard`, modes/setup.ts:119-122) so re-authenticating
does not replay the introduction. And the whole module is lazily imported only
when setup is stale or forced — the "cold-launch gate" (main.ts:614-632).

---

## 4. The rest of the interface

- **Editor** (`components/editor.ts`, 4,276) — vim state machine, a
  keybindings manager, bracketed paste with control re-encoding, a kill ring,
  autocomplete providers (slash commands, skill tokens, `^mentions`, paths),
  composer styles (bordered/band/filled), grapheme-aware movement, scrollbars.
- **Glyphs** (`theme/symbols.ts`, 1,433) — a `SymbolKey` catalogue in
  categories (`status.*`, `nav.*`, `tree.*`, `progress.*`, `context.*`,
  `boxRound/boxDotted/boxSharp.*`, `sep.powerline*`) resolved through presets
  `unicode | nerd | ascii`. Every glyph the app draws is a named lookup, so a
  symbol-set change is a preset change, not a find-and-replace.
- **Status line** (`status-line/`, 18 files, `component.ts` 3,003) — a
  **28-segment catalogue** (`schema.ts:2-30`: model, mode, path, git, pr,
  subagents, token_in/out/total/rate, cost, context_pct/total, cache_read/write/
  hit, session, stream, vim…), presets `default|minimal|compact|full|nerd|
  ascii|custom`, separator styles, and context-line modes
  `off|percentage|annotated|embedded`. Default left/right sets are data
  (`schema.ts:36-42`). The line is configuration, not code.
- **Overlays** (`overlays/`, 20+ files) — model hub, agent hub, session
  selector, tree selector, plan review, ask dialog, settings selector, MCP
  add-wizard: each a fullscreen component with its own input and mouse routing.

---

## 5. What we inherit, what we build, what we leave alone

**Inherited by depending on pi** (do not port): markdown, editor, loader,
select lists, message components, diff rendering, image handling, keybindings,
autocomplete, the basic overlay machinery. oh-my-pi carries its own copies
because it forked; we do not have to.

**Worth building, in the order it pays off:**

1. **The transcript contract.** Adopt the two-channel idea and the block
   lifecycle wholesale: `active | settled | committed`, `mutable | appendOnly`,
   `isTranscriptBlockFinalized()`, and producers that return blocks instead of
   touching the container. Our current work has folding and focus, but no
   answer to "which rows may be rewritten?" — this is that answer, and it is
   what stops a long session from re-rendering history every keystroke.
2. **Onboarding as versioned scenes**, with our own `SetupHost` (memsrv state,
   provider login, model choice, theme), `minVersion` per scene, the same gates
   (TTY, resume, env, stored version) and the same rule that completion is
   recorded once. The first-run frame we just built is the static version of
   this; the scenes are the interactive one.
3. **The status line as a segment catalogue**, not a hardcoded strip: our
   `doctor` already computes the facts (provider, model, sidecar, kernel, home)
   and currently prints them; the same values belong in a segment set with
   presets.
4. **Symbol presets** over a named glyph catalogue — we have hand-drawn glyphs
   and mascots; giving them `unicode | nerd | ascii` presets is small and makes
   them portable to terminals that cannot draw half-blocks.
5. **Bounded error rendering** (`MAX_TRANSCRIPT_ERROR_ROWS`), read-grouping, and
   a per-tool renderer registry with a safe wrapper. Each is a small file with a
   large effect on how the transcript feels.

**Deliberately not copying:** the 6,918-line interactive mode, the 3,003-line
status component, the fullscreen mouse-mode matrix, kitty graphics, collab/
streaming-to-viewers, and the 28 segments. They are the shape of a product with
a different surface area; taking them would buy weight we have not earned.

**One caution to carry forward.** Their polish lives in *details with reasons* —
autowrap discipline, per-row dissolve jitter, the 8-row error bound, the
raised-cosine thinking pulse, scoped renders after a measured 20% CPU cascade.
Copying the visuals without the reasons would give us an interface that looks
similar and performs worse. Every item above is cheap; the half-understood
version of each is not.
