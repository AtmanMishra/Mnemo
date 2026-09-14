# Archive

History, not instructions. Nothing here describes how Mnemo works *today* — if
something in this folder contradicts `docs/MNEMO.md` or
`docs/MNEMO-INTERNALS.md`, the newer document is right and this one is a record
of how it got there.

Kept because it is genuinely useful in three cases: understanding why a decision
was made (the design papers argue positions the current code only embodies), the
audit trail (what was checked, when, and with what evidence), and the diagrams
(hand-drawn Excalidraw sources that are easier to edit than to re-derive).

| What | Why it is here |
|---|---|
| `ARCHITECTURE.md`, `DATAFLOW.md`, `KERNEL.md`, `PI-INTEGRATION.md`, `MEMORY.md` | Superseded by `docs/MNEMO-INTERNALS.md`, which folds their content into one document. These were accurate when written; several details have since moved. |
| `system-design.md`, `memory-layer-design.md`, `EVAL-RESEARCH.md` | The original specs. Useful for the *argument* (alternative designs, the eval methodology), not for the current shape. |
| `HANDOFF.md`, `HANDOFF_PROMPT.md` | Cold-start onboarding written for a different contributor. `docs/MNEMO.md` + `AGENTS.md` replace it. |
| `research/*.md` | Design studies and reports from the build: brain areas, the UI identity, the audit, upstream studies, the TUI adoption decision. |
| `research/scrapling-examples/` | Sample scripts that accompanied the web-fetch study. |
| `diagrams/` | Excalidraw/HTML diagram sources referenced by the documents above. |
