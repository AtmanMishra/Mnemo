# Does the code index earn its place?

Measured 2026-10-20 on Mnemo's own `app/src` (202 files, 868 declarations), by
`cd app && bun eval/code-index.ts`. No model and no network: the TypeScript compiler is the
referee (its definitions and its call sites are the ground truth) and `grep -rnw` is the baseline,
what an agent without the index runs. Sizes are characters; 4 is about a token.

The harness found three problems in the first version of the tools. They are fixed in the same
change, so both columns are here.

## Results

**Cost.** Cold build of the whole project 1.5 s, a refresh with nothing changed 1 ms, 2.9 MB on disk.
Nothing is indexed until the agent first asks a code question; there is no watcher.

**Find a definition by its name** (150 symbols)

| | before | after |
|---|---|---|
| `code_search` finds it first | 66% | **84%** |
| in the top 3 / top 10 | 91% / 97% | 97% / 100% |
| `grep -rnw name` has the line in its output | 100% (median 7 lines, mean 20) | same |

Cause: asking for `save` ranked by text match, so a longer name with `save` in it could beat the
exact one. An exact name or qualified name now comes first.

**Find a definition from words about it** (150 symbols; the query is the first words of its doc comment)

| | first | top 3 | top 10 |
|---|---|---|---|
| `code_search` | 18% | 30% | 45% |
| `grep -i` on the longest word, definition inside the first 40 lines | 44% | | |

This is not good. Describing a function in words finds it less often than a plain grep does.
The index is for names and structure; for "the code that does X" the agent still greps. The tool
description says so ("use grep for text inside bodies"). Not changed.

**Who uses X** (150 symbols that have at least one call, `new`, extends or implements)

| | call-site precision | call-site recall | answer size (median) |
|---|---|---|---|
| `code_refs`, confirmed links (what it lists as users) | **99%** | 84% | 168 chars |
| `code_refs`, with the guessed links as well (before) | 67% | 90% | |
| `grep -rnw name` | 15% | 99% | 947 chars |

Links the index is sure of (same file, an import, a typed receiver) are 99% right. Links it only
guessed (one definition of that name, receiver type not shown) were right 13% of the time: a call to
`.get()` on a Map was tied to the project's only `get`. They are now listed apart, as "possible",
five at most, and left out of any decision. grep finds nearly every site but returns about six times
the text, 85% of it other things with the same word.

**`codeImpact`, the note appended to an edit** (80 functions with callers in other files; each edit made in a copy)

| edit | note appears (before → after) | lines naming a real caller (before → after) | caller files named (before → after) |
|---|---|---|---|
| a change inside the body, callers cannot break | 98% → **1%** | 77% → 100% | |
| a new required parameter, callers break | 99% → 92% | 77% → **99%** | 77% → 62% |
| the function renamed, callers break | **23% → 93%** | 27% → **98%** | 10% → 61% |

Before, the note fired on nearly every edit (it compared a hash of the whole definition), so it was
noise on the edits that cannot hurt a caller, and it missed renames and removals, the edits that do.
Now it fires on a changed signature or a definition that is gone, counts only confirmed links, and
reads the callers before the file is re-read, so a removed function still has them. It adds about
250 characters when it fires. Recall of caller files is 61-62% because a note shows at most 8 lines,
3 per definition.

## What this does not show

- That a model given these answers does better. It shows the answers are right and small; a task
  success rate needs a real model and a real key.
- Anything outside TypeScript. The other languages (Python, Rust, Go) are covered by unit tests, not by this measure.
- Other codebases. One project, its own, with its own naming habits.

## Decisions

`codeIndex` and `codeImpact` stay on: after the fixes both are cheap, lazy, and mostly right. Re-run
the eval before changing the extractor or the ranking, and put the numbers in the pull request.

## grep behind the text index

`cd app && bun eval/grep-index.ts [repo]`. The code index also keeps a trigram index of every text
file (SQLite FTS5, contentless: which three-character sequences a file holds, never its text). A
`grep` call reads only the files holding every trigram the pattern needs, and matches them line by
line in JavaScript. pi's grep needs ripgrep, and Mnemo sets `PI_OFFLINE`, so pi no longer
downloads it: a read-only sub-agent's grep failed wherever rg was not installed. Now grep uses
ripgrep when it is installed and the text index when it is not.

Measured 2026-10-28 on a Linux container, warm cache. "Indexed" and "all files" are a call as the
agent makes one (100 matches at most); rg is given the same file list and finds every match.

**Mnemo** (517 text files; built in 0.8 s, 6.8 MB; freshness check 4 ms per call)

| pattern | candidates | indexed | all files | rg |
|---|---|---|---|---|
| `parseConfig` | 47 | 4 ms | 13 ms | 7 ms |
| `settings\.get\(\)` | 19 | 1 ms | 10 ms | 7 ms |
| `zzqxv_never_there` | 1 | 0 ms | 9 ms | 6 ms |

**VS Code** (`microsoft/vscode`, 19,664 text files; built in 33 s, 45 MB; freshness check 109 ms per call)

| pattern | candidates | indexed | all files | rg |
|---|---|---|---|---|
| `parseConfig` | 1,451 | 190 ms | 578 ms | 83 ms |
| `settings\.get\(\)` | 573 | 106 ms | 547 ms | 77 ms |
| `zzqxv_never_there` | 0 | 8 ms | 540 ms | 88 ms |
| `TODO\|FIXME` | 1,205 | 24 ms | 53 ms | 92 ms |
| `import .* from` | 14,283 | 18 ms | 1 ms | 303 ms |

The lines matched ripgrep's for all 8 patterns in both repositories: every line of rg's, and no
other, or (where the output passes 50 KB and is cut, as pi's grep cuts it) only lines of rg's.

What it says: against reading every file, a rare name is 3 to 70 times faster. Against ripgrep,
which searches in parallel, it is not faster on a large repository once the freshness check (git's
file list and a stat of each file, about 110 ms at 20,000 files) is counted; it is about level, and
the first grep in a large repository pays the build (33 s at 20,000 files; later calls re-read only
changed files). Hence the decision: ripgrep when it is installed, the index only when it is not,
which is the usual case on Windows and macOS. Common patterns stop at 100 matches either way.

Not shown: a pattern ripgrep reads and JavaScript reads differently (POSIX classes, inline flags
other than a leading `(?i)`, `\p{…}`, `\A`, `\z`) is passed to ripgrep, or refused with the reason
when it is not installed. Trigrams use ASCII only, so a non-ASCII literal narrows nothing.
