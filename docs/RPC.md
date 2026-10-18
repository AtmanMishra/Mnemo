# `mnemo --rpc`

The session over JSON lines, for an editor or any other front end. One JSON object per line;
commands on standard input, events on standard output, diagnostics on standard error.
Protocol 1. The terminal interface and this one are two views of the same `Controller`
(`app/src/runtime/rpc.ts`), so a slash command, a login or an approval behaves the same way.

    mnemo --rpc [--cwd dir] [--plan] [--continue] [--trust-project] [--no-memory]

`--yolo` and `--accept-edits` are accepted as in the terminal, but a client should not pass them:
the mode is the user's to change, in the client's UI, with `setMode`.

## Approvals are the client's to answer

A tool call that would ask becomes a `dialog` event with the same request the terminal shows.
It runs only when the client sends the matching `answer`; the process never answers for a client,
there is no flag that does, an ask stays open until answered, and when the client's input closes
every open dialog resolves as "no". Only the oldest dialog can be answered, an answer with another id is ignored, and
`always` is accepted only when the request offered an `always` pattern.

## Events (out)

| `type` | fields |
|---|---|
| `ready` | `protocol`, `version`, `cwd`, `hasModel`, `commands` (`name`, `description`, `source`) |
| `transcript` | `reset`, `epoch`, `from`, `committed` (blocks appended at index `from`; all of them when `reset`), `live` (blocks still changing, replaced each time), `working` (`since`, `tokens`) or null, `queue` |
| `chrome` | `footer` (`model`, `thinking`, `contextPercent`, `cost`, `cwd`, `branch`, `mode`, `memory`), `statuses`, `activity` |
| `dialog` | `dialog`: `{id, kind: "approval", tool, subject, preview[], always?, reason?}`, `{id, kind: "select", title, choices[], initial?}`, `{id, kind: "confirm", title, message}` or `{id, kind: "text", title, placeholder?, initial?, secret?}` |
| `dialogClosed` | `id` |
| `roster` | `nodes` (the agent tree: `id`, `parent`, `label`, `task`, `status`, `access`, `steps`, `answer`…), `self` |
| `settings` | `values`; `defs` (`groups`, `items` with `key`, `group`, `label`, `help`, `kind`, `default`, `min`, `max`, `options`, `restart`) in the first one |
| `result` | `id`, `ok`, `value?`, `error?`: the answer to a command that carried an `id` |
| `error` | `message`: a refusal of a command sent without an `id`, or unparseable input |

State events (`chrome`, `roster`, `settings`) are sent only when they change; `transcript` is coalesced to about 30 ms.
Block shapes are `app/src/ui/store.ts`'s `Block`.

## Commands (in)

Add an `id` (number) to get a `result`.

| `type` | fields | effect |
|---|---|---|
| `submit` | `text`, `steer?` | what typing it in the terminal does: a prompt, or a `/command` |
| `interrupt` | | stop the run (esc) |
| `answer` | `id`, then `answer: {kind: "yes" \| "always" \| "no", feedback?}` for an approval, `value` for select and text, `ok` for confirm; none of them cancels | resolve the dialog on screen |
| `setMode` | `mode`: `default`, `accept-edits`, `plan`, `yolo` | |
| `cycleThinking` | | |
| `setSetting` | `key`, `value` | validated and saved by the same store as `/settings`; the reason comes back when it is refused |
| `resetSetting` | `key?` | one setting, or all |
| `memory` | `query?` | `result.value`: `{available, project[], user[], hits[]}` |
| `quit` | | |

## Not in protocol 1

One agent per process (the terminal's multi-agent fleet is not exposed), no file-content
or checkpoint events (a client reads the file itself), and no way to answer a dialog out of order.
