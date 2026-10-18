# Mnemo for VS Code

[Mnemo](https://github.com/AtmanMishra/Mnemo) as a panel in the editor: chat, approvals, diffs, memory, agents and every Mnemo setting, with the agent running exactly as it does in a terminal.
Install Mnemo first (`mnemo` on your PATH, or set `mnemo.path`), then click the Mnemo icon in the activity bar.

| | |
|---|---|
| **Chat** | Streaming answers, thinking, tool calls with their output, and edits as coloured diffs with an *Open file* button. `/` completes Mnemo's commands (`/model`, `/login`, `/resume`, `/rewind`, `/compact`, skills…); anything they ask opens as a form in the panel. Messages typed while it works are queued. |
| **Approvals** | Every command and edit Mnemo would ask about in a terminal is a card above the prompt, with the command or the diff. *Allow once*, *Always allow* (only when Mnemo offers a safe pattern) or *Deny*, with a line telling it what to do instead. The status bar turns amber and a notice appears if the panel is hidden. |
| **Theme** | *Match VS Code* (default) or any of Mnemo's eleven palettes, the same ones as the terminal (Mnemo Night, Dracula, Nord, Gruvbox, Tokyo Night, Catppuccin Mocha, Synthwave, Amber CRT, Game Boy, Paper, Solarized Light), from the picker in the header or `mnemo.theme`. |
| **Mode** | *Ask first*, *Accept edits*, *Plan (read-only)* from the header. *Bypass* needs a second confirmation and lasts for the session. |
| **Agents** | The agent tree: sub-agents Mnemo started, their task, steps, status and answer. |
| **Memory** | What Mnemo remembers about the project and about you, search, *Remember…*, *Forget*. |
| **Settings** | All of Mnemo's settings, grouped, validated by Mnemo itself, with reset and a note when one applies at the next launch. |
| **Editor** | *Ask About the Selection* (`ctrl+alt+a`) and *Ask About This File* put the path, line range and code in the prompt for you to finish and send. *Review Changes* opens Source Control. *Open Mnemo in the Terminal* runs the plain terminal interface instead. |

## How it works

The extension starts `mnemo --rpc` in your workspace folder and talks to it in JSON lines over standard input and output (the protocol is [`docs/RPC.md`](../docs/RPC.md)). There is no server, no port and no network call of the extension's own.

## Approvals and security

- Every ask is answered by you, by clicking, in the panel. The extension never answers one, never starts Mnemo with `--yolo` or `--accept-edits`, and has no setting that does. An ask left open stays waiting for you; if Mnemo exits it counts as *no*.
- Mnemo's permission gate filters; it is not a sandbox (see the repository's `SECURITY.md`). Plan mode is read-only.
- `mnemo.path`, `mnemo.mode` and `mnemo.trustProject` are machine-scoped and ignored in untrusted workspaces, so a repository cannot choose which program runs or switch on its own `.pi/` extensions. By default a folder's `.pi/` code is not loaded.
- The panel renders model output as text nodes, never as HTML, under a strict content security policy.

## Limits

- One Mnemo session per window, in the first workspace folder. Split panes and several agents side by side are the terminal interface's.
- Diffs are shown in the panel; there is no side-by-side editor diff yet.
- Mnemo's terminal-only settings (look, keys) are listed but folded.

## Develop

    cd vscode && npm install && npm run typecheck && npm test
    npm run package        # writes mnemo-vscode-<version>.vsix

To run it, open `vscode/` in VS Code and press F5 (needs `mnemo` on PATH; `mnemo --rpc --demo` is a keyless scripted session).
