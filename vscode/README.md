# Mnemo for VS Code

Runs [Mnemo](https://github.com/AtmanMishra/Mnemo) in an editor terminal and adds editor commands around it.
Install Mnemo first (`mnemo` must be on your PATH, or set `mnemo.path`).

| Command | What it does |
|---|---|
| **Mnemo: Open Mnemo** (`ctrl+alt+m`) | Starts Mnemo in this folder, or shows the running one. |
| **Mnemo: Continue the Last Session** | Starts it with `--continue`. |
| **Mnemo: Ask About the Selection** (`ctrl+alt+a`) | Types `Look at <file> lines a-b: ` into Mnemo's input. You finish the question and press enter. |
| **Mnemo: Ask About This File** | The same for a whole file (editor and explorer menus). |
| **Mnemo: Review Changes** | Opens Source Control: Mnemo edits files in place, so the diff is git's. |
| **Mnemo: Show Memory Status** | Runs `mnemo memory status`. |

## Approvals

Every command and edit is decided by Mnemo's own approval prompt, in the terminal, exactly as in a plain terminal.
The extension never answers it, never passes `--yolo` or `--accept-edits`, and has no setting that does. `mnemo.mode: plan` starts read-only.
Mnemo's permission gate filters; it is not a sandbox (see the repository's `SECURITY.md`).

The extension does not paste your code into the terminal. It sends a file and line range, and Mnemo reads it through its own tools, under the same gate.
`mnemo.path` and `mnemo.mode` are machine-scoped and ignored in untrusted workspaces, so a repository cannot choose which program runs.

## Not here yet

Approvals and diffs inside the editor itself need a machine-readable interface in Mnemo (an RPC or JSON event stream with a way to answer ask prompts). Mnemo has none: `mnemo -p` prints one answer and allows what would ask. When that exists, this extension is where to surface it.

## Develop

    cd vscode && npm install && npm run typecheck && npm test
    npm run package        # writes mnemo-vscode-<version>.vsix
