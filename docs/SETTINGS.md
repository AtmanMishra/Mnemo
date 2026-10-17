# Settings

Everything you can tune lives in one place: `/settings` in a session opens a menu (type to
filter, enter to change, esc to leave), `/settings <name> <value>` changes one setting in a
sentence, and `mnemo settings` does the same from a shell. Every default is what Mnemo did
before there was a menu, so a fresh install behaves as it always has.

    /settings                      the menu
    /settings hops 20              set one; /settings hops says what it is and its range
    /settings reset wakeSpend      one back to its default (`reset` alone: all of them)
    mnemo settings                 list them all, with what differs from the default
    mnemo settings set theme nord  the same change without a session

A value that does not fit (a word where a number goes, a number out of range, a chord another key
already holds) is refused with the reason; nothing is clamped into something you did not pick.

## Where they are kept

`config.json` in the Mnemo home (`~/.mnemo`, or `$MNEMO_HOME`), mode 0600, holding only the
choices that differ from the default, so deleting the file, or `/settings reset`, restores
everything. The theme and the daily update check stay in `state.json`, where `/theme` and
`mnemo update --auto` already put them. A file that is damaged or edited by hand into nonsense
is read value by value: each good one is kept, every other one is its default.

A flag or an environment variable names one run and wins over the file (`--no-motion`,
`--no-reflect`, `--escalate`, `MNEMO_MOUSE=0`, `MNEMO_NOTIFY=0`, `MNEMO_ESCALATE_MODEL`). The file can
switch off what is on by default, but it never turns on what a flag turned off.

A † marks a setting read when Mnemo starts; the menu says so when you change one. Everything
else applies at once, in every open agent.

## What a setting cannot do

None of them loosens the permission gate. The default mode offers `default` and `plan` only:
bypass (`yolo`) and accept-edits stay a choice you make in a session (`--yolo`, `shift+tab`),
never something a file turns on at launch. The agent limits are ceilings with fixed bounds
(for example at most 64 sub-agents per conversation), and every one of them only governs how
much agents may do on their own; what an agent may *touch* is decided by the gate, as before.

## The settings

### Look

| Setting | Name | Default | Values | What it does |
|---|---|---|---|---|
| Theme | `theme` | night | night · gameboy · paper · dracula · nord · gruvbox · tokyo · mocha · solarized · amber · synthwave | the palette |
| Animation † | `motion` | on | on · off | pixel art, the working indicator and the memory graph move |
| Launch sequence † | `bootAnimation` | on | on · off | the boot animation when Mnemo starts |
| Mouse wheel | `mouse` | on | on · off | the wheel scrolls the conversation (off: your terminal selects text) |
| Wheel speed | `wheelRows` | 3 lines | 1–20 | lines the conversation moves per wheel notch |
| Sidebar open † | `sidebar` | on | on · off | start with the sidebar (files, memory, sessions) shown |
| Sidebar width | `sidebarWidth` | 34 columns | 24–60 | columns the sidebar takes |
| Split layout | `splitLayout` | auto | auto · grid · cols · rows · main-left | how split panes are arranged (auto picks by terminal width) |
| Expand output | `expandOutput` | off | on · off | start with tool output fully shown (ctrl+o toggles it) |
| Toast time | `toastSeconds` | 4.5 s | 1–30 | seconds a notice from another agent stays |
| Toasts at once | `toastMax` | 3 | 1–6 | how many notices show together |

### Behaviour

| Setting | Name | Default | Values | What it does |
|---|---|---|---|---|
| Default mode † | `mode` | default | default · plan | how much Mnemo may do without asking (bypass modes are never a default) |
| Learn after runs | `reflect` | on | on · off | write durable facts to memory after each run (--no-reflect overrides) |
| Check changed code | `verify` | on | on · off | send a run that changed code back to run a check (--no-verify overrides) |
| Escalation model | `escalateModel` | none | provider/model-id, or empty | provider/id to finish a run on after failed checks; empty for none |
| Escalate after | `escalateAfter` | 2 checks | 1–10 | failed checks in one run before escalating |
| Python cell time | `kernelTimeout` | 120 s | 5–3600 | seconds a Python cell may run when it names no limit |
| Python cell ceiling | `kernelMaxTimeout` | 600 s | 5–3600 | the longest a Python cell may ask to run |

### Agents

| Setting | Name | Default | Values | What it does |
|---|---|---|---|---|
| Sub-agent depth | `maxDepth` | 3 | 0–6 | how deep sub-agents nest (0: none; raising it reaches conversations opened after) |
| Sub-agents per agent | `maxChildren` | 4 | 1–16 | live sub-agents one agent may have |
| Sub-agents per conversation | `maxLive` | 16 | 1–64 | live sub-agents under one conversation, at any depth |
| Message chain | `hops` | 12 messages | 1–100 | messages agents may pass in a row before waiting for you |
| Woken-turn budget | `wakeSpend` | $0.50 | 0–100 | dollars an agent may spend on turns that messages start, between your prompts (0: messages never wake it) |
| Reply wait | `replyWait` | 120 s | 5–900 | seconds an agent waits for an answer it asked another agent for |
| Message length | `messageChars` | 2000 chars | 100–20000 | characters in one agent-to-agent message |
| Message rate | `sendsPerMinute` | 30 | 1–300 | messages one agent may send per minute |
| Held messages | `inbox` | 20 | 1–200 | messages an agent may hold for your next prompt |

### Notifications

| Setting | Name | Default | Values | What it does |
|---|---|---|---|---|
| Desktop notice † | `notify` | on | on · off | tell the terminal when a long turn ends or Mnemo asks, while it is in the background (MNEMO_NOTIFY=0 overrides) |
| Notify after | `notifyAfter` | 20 s | 0–3600 | a turn must run this long to notify |
| Update check † | `autoUpdate` | off | on · off | once a day at launch, ask GitHub whether a newer Mnemo exists (never installs) |

### Keys

Rebind the chords that are not text editing. A chord is `ctrl+<letter>` or
`alt+<letter, comma, period, slash, semicolon or dash>`. The line-editing keys (`ctrl+a e u w k h j m i`),
`ctrl+c`/`ctrl+d`, and `alt+b`/`alt+f` belong to the prompt and are refused; `ctrl+k` is shared
only by the palette, which yields to it on a prompt with text. Two actions cannot hold one chord:
the refusal names the one that has it. The footer, `?` panel and `/help` show the chords as bound.

| Setting | Name | Default | Values | What it does |
|---|---|---|---|---|
| Palette | `keys.palette` | ctrl+k | ctrl+x · alt+x | go to a command, agent, session or file; in the prompt, only while it is empty |
| Sidebar | `keys.sidebar` | ctrl+b | ctrl+x · alt+x | show or hide the sidebar |
| Find | `keys.find` | ctrl+f | ctrl+x · alt+x | find in the conversation |
| Expand output | `keys.expand` | ctrl+o | ctrl+x · alt+x | expand thinking and tool output |
| Clear screen | `keys.clear` | ctrl+l | ctrl+x · alt+x | clear the screen |
| Thinking level | `keys.thinking` | ctrl+t | ctrl+x · alt+x | cycle the thinking level |
| Hub | `keys.hub` | ctrl+g | ctrl+x · alt+x | the hub: a card per agent |
| Playground | `keys.playground` | ctrl+y | ctrl+x · alt+x | the playground: every agent and the messages between them |
| Switch project | `keys.projects` | ctrl+p | ctrl+x · alt+x | switch project, or open one by typing its path |
| New agent | `keys.newAgent` | ctrl+n | ctrl+x · alt+x | another agent on this project, in parallel |
| Split view | `keys.split` | ctrl+s | ctrl+x · alt+x | split the screen between agents |
| Next layout | `keys.layout` | alt+l | ctrl+x · alt+x | in a split, the next layout |
| Previous agent | `keys.prevAgent` | alt+, | ctrl+x · alt+x | previous agent (every pane, in a split) |
| Next agent | `keys.nextAgent` | alt+. | ctrl+x · alt+x | next agent (every pane, in a split) |

† takes effect the next time Mnemo starts.
