# Mnemo pre-alpha installer — Windows.
#
#   Run it from a checkout of this repository, in PowerShell:
#
#       .\scripts\install.ps1              # checks, builds, installs
#       .\scripts\install.ps1 -DryRun      # say what it would do, change nothing
#
# What it does, in order: checks your toolchain, installs the agent runtime's
# dependencies, builds the memory sidecar (if you have Rust) and the interface
# (if you have Go), then puts `mnemo.exe` where you can run it from anywhere.
#
# Nothing here is irreversible and nothing writes outside the repository,
# ~\.local\bin and the toolchain's own caches. -DryRun proves that.
param([switch]$DryRun)

$ErrorActionPreference = "Stop"

$Root   = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BinDir = if ($env:MNEMO_BIN_DIR) { $env:MNEMO_BIN_DIR } else { Join-Path $HOME ".local\bin" }
$NodeFloor = "22.18"

function Step($msg) { Write-Host "`n==> $msg" }
function Say($msg)  { Write-Host "    $msg" }
function Ok($msg)   { Write-Host "  ok  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  !   $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "`nFAIL $msg`n" -ForegroundColor Red; exit 1 }

function Invoke-Step($dir, $what, [scriptblock]$action) {
  if ($DryRun) { Say "would run: $what (in $dir)" } else { Push-Location $dir; try { & $action } finally { Pop-Location } }
}

Write-Host "`nMnemo pre-alpha installer"

# --- 1. is this actually a checkout -----------------------------------------
Step "Checking the checkout"
foreach ($d in @("agent", "memory-layer", "tui-go")) {
  if (-not (Test-Path (Join-Path $Root $d))) {
    Die "$Root does not look like the Mnemo repository (no $d\).
    Clone it first:  git clone https://github.com/AtmanMishra/self-evolving-agent"
  }
}
Ok "found agent\, memory-layer\ and tui-go\"

# --- 2. the one hard requirement --------------------------------------------
# 22.18 is where Node runs .ts files with no flag; below it every file in
# agent\ dies on a type annotation, which reads as a Mnemo bug.
Step "Checking Node (>= $NodeFloor required)"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Die "node is not on PATH.
    Install Node $NodeFloor or newer:  winget install OpenJS.NodeJS
    (or https://nodejs.org/en/download)"
}
$NodeV = (& node -p "process.versions.node").Trim()
$NodeOk = & node -p "const [m,n]=process.versions.node.split('.').map(Number); (m>22 || (m===22 && n>=18)) ? 1 : 0"
if ($NodeOk.Trim() -ne "1") {
  Die "Node $NodeV is too old: Mnemo runs TypeScript directly, and that needs $NodeFloor+.
    winget install OpenJS.NodeJS   (or nvm-windows: nvm install $NodeFloor)"
}
Ok "node $NodeV"

# --- 3. the agent runtime ---------------------------------------------------
Step "Installing the agent runtime (agent\)"
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Die "npm is not on PATH — it ships with Node; reinstall Node." }
Invoke-Step (Join-Path $Root "agent") "npm install" { npm install --silent } | Out-Null
if (-not $DryRun) { Ok "npm dependencies installed" }

# --- 4. the memory sidecar (optional) ---------------------------------------
Step "Building the memory sidecar (memory-layer\) — optional"
if (Get-Command cargo -ErrorAction SilentlyContinue) {
  Invoke-Step (Join-Path $Root "memory-layer") "cargo build --bin memsrv" { cargo build --bin memsrv } | Out-Null
  if (-not $DryRun) { Ok "memsrv.exe ready (skip it and the Memory pane stays offline; nothing else changes)" }
} else {
  Warn "cargo not found — memory will be offline."
  Warn "To enable it: https://rustup.rs then re-run this script."
}

# --- 5. the interface -------------------------------------------------------
Step "Building the interface (tui-go\)"
$tui  = Join-Path $Root "tui-go"
$exe  = Join-Path $tui "mnemo.exe"
if (Get-Command go -ErrorAction SilentlyContinue) {
  Invoke-Step $tui "go build -o mnemo.exe ./cmd/mnemo" { go build -o mnemo.exe ./cmd/mnemo } | Out-Null
  if (-not $DryRun) { Ok "built tui-go\mnemo.exe" }
} elseif (Test-Path $exe) {
  Ok "no Go toolchain, but tui-go\mnemo.exe is already here (the release binary)"
} else {
  Die "Neither Go nor a prebuilt binary.
    Build it:     install Go (https://go.dev/dl) and re-run
    Or download:  the mnemo-<tag>-windows-amd64.exe binary from
                  https://github.com/AtmanMishra/self-evolving-agent/releases
                  and put it at tui-go\mnemo.exe"
}

# --- 6. put it on PATH ------------------------------------------------------
Step "Installing to $BinDir"
if (-not $DryRun) {
  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  Copy-Item -Force (Join-Path $tui "mnemo.exe") (Join-Path $BinDir "mnemo.exe")
}
Ok "$BinDir\mnemo.exe"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$BinDir*") {
  Warn "$BinDir is not on your PATH. Add it with:"
  Warn "  [Environment]::SetEnvironmentVariable('Path', `"$userPath;$BinDir`", 'User')"
  Warn "  (then open a new terminal)"
}

# --- 7. what to do now ------------------------------------------------------
Write-Host "`nDone.`n"
Say "mnemo --version                      # the build you just installed"
Say "mnemo --repo $Root                  # start it, pointed at this checkout"
Write-Host ""
Say "First run: /login walks you through picking a provider and pasting a key."
Say "Bugs and rough edges: https://github.com/AtmanMishra/self-evolving-agent/issues"
Write-Host ""
