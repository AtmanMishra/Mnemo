#Requires -Version 5.1
<#
  Mnemo onboarding installer - Windows.

    .\scripts\install.ps1                 interactive onboarding (asks)
    .\scripts\install.ps1 -Yes            non-interactive; takes the defaults
    .\scripts\install.ps1 -DryRun         prints every command, runs none
    .\scripts\install.ps1 -InstallDir X   override the install directory

  Built on gum (https://github.com/charmbracelet/gum) when it is available, and
  on plain PowerShell prompts when it is not. gum is bootstrapped below and is
  never assumed to exist: a machine without it gets the same choices, drawn by
  Read-Host.

  Two things this script takes seriously.

  1. gum's interactive widgets (choose/confirm/input/filter/write/file/pager)
     HANG FOREVER - they do not error - when there is no console attached: CI,
     a pipe, a scheduled task, Start-Process. Measured, not assumed. So
     interactivity is decided exactly once, before any widget could be called,
     and those widgets are never called when the answer is "no". Only
     style/spin/log/format/join/table are used freely, and those are safe
     everywhere.

  2. Every failure message names the command that fixes it.

  Set MNEMO_NO_GUM=1 to force the plain-prompt path even when gum is installed.
#>
[CmdletBinding()]
param(
    [switch]$Yes,
    [switch]$DryRun,
    [string]$InstallDir = ''
)

$ErrorActionPreference = 'Stop'

$NodeFloor = '22.18'
$GoFloor   = '1.22'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if (-not $InstallDir) {
    $local = $env:LOCALAPPDATA
    if (-not $local) { $local = Join-Path $HOME 'AppData\Local' }
    $InstallDir = Join-Path $local 'Programs\mnemo'
}

$script:Gum         = $null
$script:Interactive = $false
$script:Failures    = @()
$script:NotDone     = @()
$script:StepNo      = 0

# ---------------------------------------------------------------------------
# output
# ---------------------------------------------------------------------------

function Step([string]$msg) { Write-Host ''; Write-Host "==> $msg" -ForegroundColor White }
function Say([string]$msg)  { Write-Host "    $msg" }
function Ok([string]$msg)   { Write-Host "  ok  $msg" -ForegroundColor Green }
function Warn([string]$msg) { Write-Host "  !   $msg" -ForegroundColor Yellow }
function Bad([string]$msg)  { Write-Host "  x   $msg" -ForegroundColor Red }
function Tail([string]$msg) { Write-Host "      $msg" -ForegroundColor DarkGray }

# A binary that was just written but refuses to launch is not a Mnemo failure:
# it is antivirus or an endpoint-protection policy. Say which, and say what to
# do about it, rather than pointing at the issue tracker.
function Show-LaunchBlockedHint($outputLines) {
    $text = ($outputLines -join ' ')
    if ($text -match 'Access is denied|Permission denied|failed to run') {
        Write-Host ''
        Warn 'that is a refusal to launch the file, not a Mnemo failure. Antivirus or an'
        Warn '  endpoint-protection policy is blocking the binary that was just copied.'
        Warn '  to fix:  install it somewhere that policy allows, e.g.'
        Warn '           .\scripts\install.ps1 -InstallDir "$env:LOCALAPPDATA\mnemo"'
        Warn '           (or the same for a directory your AV already trusts)'
    }
}

function Pad-Text([string]$s, [int]$n) {
    if ($null -eq $s) { $s = '' }
    if ($s.Length -ge $n) {
        if ($n -le 3) { return $s.Substring(0, $n) }
        return $s.Substring(0, $n - 1) + '~'
    }
    return $s + (' ' * ($n - $s.Length))
}

# ---------------------------------------------------------------------------
# native command helper
#
# $ErrorActionPreference = 'Stop' plus native stderr folded into the success
# stream turns every stderr line into a terminating ErrorRecord on PowerShell
# 5.1, so every native call goes through here: the preference is relaxed for the
# duration and the exit code is read explicitly.
#
# Without -Capture the child is NOT piped at all - its stdout and stderr go
# straight to the console. That matters: piping gum's output would cost it the
# TTY it needs to draw and to read a keypress.
# ---------------------------------------------------------------------------

function Invoke-Native {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [string[]]$Arguments = @(),
        [string]$WorkDir = '',
        [switch]$Capture,
        [switch]$Interactive
    )

    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $oldDir = ''
    $captured = @()
    $code = 1

    try {
        if ($WorkDir) { $oldDir = (Get-Location).Path; Set-Location -LiteralPath $WorkDir }

        if ($Capture) {
            if ($Interactive) {
                # Capture stdout only and leave stderr attached to the console.
                # gum draws its menus on stderr, so folding stderr into the
                # success stream would capture the menu instead of showing it -
                # the widget still works, but the user sees nothing while it
                # waits for a keypress, which reads as a hang.
                $captured = @(& $Exe @Arguments)
            }
            else {
                $captured = @(& $Exe @Arguments 2>&1 | ForEach-Object { [string]$_ })
            }
        }
        else {
            & $Exe @Arguments
        }

        $code = $LASTEXITCODE
        if ($null -eq $code) { $code = 0 }
    }
    catch {
        $captured = @($_.Exception.Message)
        $code = 1
    }
    finally {
        if ($oldDir) { Set-Location -LiteralPath $oldDir }
        $ErrorActionPreference = $prevPref
    }

    $result = New-Object psobject
    Add-Member -InputObject $result -MemberType NoteProperty -Name ExitCode -Value $code
    Add-Member -InputObject $result -MemberType NoteProperty -Name Output   -Value $captured
    return $result
}

function Get-NativeText {
    param([string]$Exe, [string[]]$Arguments = @(), [string]$WorkDir = '')
    $r = Invoke-Native -Exe $Exe -Arguments $Arguments -WorkDir $WorkDir -Capture
    return @{ ExitCode = $r.ExitCode; Text = (($r.Output -join ' ')).Trim() }
}

# ---------------------------------------------------------------------------
# versions
# ---------------------------------------------------------------------------

function Get-VersionParts([string]$s) {
    $m = [regex]::Match([string]$s, '(\d+)(?:\.(\d+))?(?:\.(\d+))?')
    if (-not $m.Success) { return @(0, 0, 0) }
    $a = [int]$m.Groups[1].Value
    $b = 0; if ($m.Groups[2].Success) { $b = [int]$m.Groups[2].Value }
    $c = 0; if ($m.Groups[3].Success) { $c = [int]$m.Groups[3].Value }
    return @($a, $b, $c)
}

function Test-MinVersion([string]$Have, [string]$Min) {
    if (-not $Have -or -not $Min) { return $false }
    $h = Get-VersionParts $Have
    $m = Get-VersionParts $Min
    for ($i = 0; $i -lt 3; $i++) {
        if ($h[$i] -gt $m[$i]) { return $true }
        if ($h[$i] -lt $m[$i]) { return $false }
    }
    return $true
}

function Resolve-Tool([string]$name) {
    $c = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $c) { return $null }
    return $c.Source
}

# ---------------------------------------------------------------------------
# interactivity - decided once, before anything could hang on it
# ---------------------------------------------------------------------------

function Test-ConsoleAvailable {
    try {
        if (-not [Environment]::UserInteractive) { return $false }
        # UserInteractive is true in some contexts even with a redirected
        # console; ask the console handles directly. These throw when there is
        # no console at all (service, Start-Process, scheduled task).
        if ([Console]::IsInputRedirected)  { return $false }
        if ([Console]::IsOutputRedirected) { return $false }
        return $true
    }
    catch {
        return $false
    }
}

# ---------------------------------------------------------------------------
# prompts - gum only when the console can take it, Read-Host otherwise
# ---------------------------------------------------------------------------

function Ask-Confirm([string]$question, [bool]$defaultYes) {
    if (-not $script:Interactive) { return $defaultYes }

    if ($script:Gum) {
        $cmdArgs = @('confirm', $question, '--affirmative', 'yes', '--negative', 'no')
        if ($defaultYes) { $cmdArgs += '--default' }
        $r = Invoke-Native -Exe $script:Gum -Arguments $cmdArgs
        return ($r.ExitCode -eq 0)
    }

    try {
        $yes = New-Object System.Management.Automation.Host.ChoiceDescription '&Yes', 'proceed'
        $no  = New-Object System.Management.Automation.Host.ChoiceDescription '&No', 'stop'
        $default = 1
        if ($defaultYes) { $default = 0 }
        $pick = $Host.UI.PromptForChoice('mnemo installer', $question, @($yes, $no), $default)
        return ($pick -eq 0)
    }
    catch {
        $suffix = '[Y/n]'
        if (-not $defaultYes) { $suffix = '[y/N]' }
        $answer = Read-Host "$question $suffix"
        if (-not $answer) { return $defaultYes }
        return ($answer.Trim().ToLower().StartsWith('y'))
    }
}

function Ask-Input([string]$question, [string]$default) {
    if (-not $script:Interactive) { return $default }

    if ($script:Gum) {
        $r = Invoke-Native -Exe $script:Gum -Arguments @('input', '--header', $question, '--value', $default, '--prompt', '> ') -Capture -Interactive
        if ($r.ExitCode -eq 0 -and $r.Output.Count -gt 0) {
            $v = ([string]$r.Output[0]).Trim()
            if ($v) { return $v }
        }
        return $default
    }

    $answer = Read-Host "$question [$default]"
    if (-not $answer) { return $default }
    return $answer.Trim()
}

# Multi-select over [pscustomobject] items with Id, Label, Why, Available,
# Selected. Returns the chosen Ids. Impossible items are never silently
# dropped: they are excluded from the picker and printed underneath with the
# reason they cannot be chosen.
function Ask-MultiSelect([string]$header, $options) {
    $selectable = @($options | Where-Object { $_.Available })
    $blocked    = @($options | Where-Object { -not $_.Available })

    if (-not $script:Interactive) {
        $chosen = @($selectable | Where-Object { $_.Selected } | ForEach-Object { $_.Id })
        Say '(no interactive console - taking the defaults; run without -Yes to choose)'
        return $chosen
    }

    $chosen = @()

    if ($script:Gum) {
        $labels   = @($selectable | ForEach-Object { $_.Label })
        $selected = @($selectable | Where-Object { $_.Selected } | ForEach-Object { $_.Label })

        $cmdArgs = @('choose', '--no-limit', '--ordered', '--header', $header, '--height', '12')
        if ($selected.Count -gt 0) { $cmdArgs += @('--selected', ($selected -join ',')) }
        foreach ($l in $labels) { $cmdArgs += $l }

        $r = Invoke-Native -Exe $script:Gum -Arguments $cmdArgs -Capture -Interactive
        if ($r.ExitCode -eq 0) {
            foreach ($line in $r.Output) {
                $t = ([string]$line).Trim()
                if (-not $t) { continue }
                foreach ($o in $selectable) { if ($o.Label -eq $t) { $chosen += $o.Id } }
            }
        }
    }
    else {
        # Plain numbered menu: the same choices and the same defaults.
        $state = @{}
        foreach ($o in $selectable) { $state[$o.Id] = [bool]$o.Selected }

        while ($true) {
            Write-Host ''
            Write-Host "    $header" -ForegroundColor White
            $i = 0
            foreach ($o in $selectable) {
                $i++
                $mark = '[ ]'
                if ($state[$o.Id]) { $mark = '[x]' }
                Write-Host ("      {0}) {1} {2}" -f $i, $mark, $o.Label) -ForegroundColor Gray
                Write-Host ("           {0}" -f $o.Why) -ForegroundColor DarkGray
            }
            $answer = Read-Host '    Toggle numbers (e.g. 1,3), or press Enter to accept'
            if (-not $answer -or -not $answer.Trim()) { break }
            foreach ($tok in $answer.Split(',')) {
                $n = 0
                if ([int]::TryParse($tok.Trim(), [ref]$n)) {
                    if ($n -ge 1 -and $n -le $selectable.Count) {
                        $id = $selectable[$n - 1].Id
                        $state[$id] = -not $state[$id]
                    }
                }
            }
        }

        foreach ($o in $selectable) { if ($state[$o.Id]) { $chosen += $o.Id } }
    }

    if ($chosen.Count -eq 0) { Warn 'nothing selected - no components will be installed' }

    foreach ($b in $blocked) {
        Write-Host ("      -  {0}  cannot be chosen: {1}" -f $b.Label, $b.Why) -ForegroundColor DarkGray
    }

    return $chosen
}

# ---------------------------------------------------------------------------
# gum
# ---------------------------------------------------------------------------

# Charm's gum prints "gum version v0.17.0". Other tools answer to the name gum
# - notably the scoop manifest literally called "gum", which is kordamp's
# Gradle/Maven wrapper and ships gm.exe - so a positive version match is
# required rather than a bare PATH hit.
function Test-CharmGum([string]$path) {
    if (-not $path) { return $false }
    $r = Invoke-Native -Exe $path -Arguments @('--version') -Capture
    if ($r.ExitCode -ne 0) { return $false }
    if (($r.Output -join "`n") -match 'gum version v?\d+\.') { return $true }
    return $false
}

function Find-Gum {
    if ($env:MNEMO_NO_GUM) { return $null }
    $p = Resolve-Tool 'gum'
    if ($p -and (Test-CharmGum $p)) { return $p }
    return $null
}

# Returns a usable gum path, or $null. Never fatal: gum is a convenience, and
# the plain prompts carry the same choices.
function Install-Gum {
    $routes = @()

    if (Resolve-Tool 'go') {
        $routes += [pscustomobject]@{
            Id = 'go'; Command = 'go install github.com/charmbracelet/gum@latest'
            Why = 'recommended: Go is already a hard requirement of this project, so nothing new is added'
        }
    }
    if (Resolve-Tool 'winget') {
        $routes += [pscustomobject]@{
            Id = 'winget'; Command = 'winget install charmbracelet.gum'
            Why = 'installs the published Windows package, charmbracelet.gum'
        }
    }
    if (Resolve-Tool 'scoop') {
        $routes += [pscustomobject]@{
            Id = 'scoop'; Command = 'scoop install charm-gum'
            Why = 'the package is called charm-gum; the scoop manifest named plain "gum" is a different tool'
        }
    }

    Write-Host ''
    Write-Host '    gum is not installed. It draws nicer menus, but nothing here depends' -ForegroundColor Gray
    Write-Host '    on it - without it you get the same choices, drawn by Read-Host.' -ForegroundColor Gray

    if ($routes.Count -eq 0) {
        Write-Host ''
        Warn 'no way to install gum on this machine (no go, no winget, no scoop) - continuing without it.'
        return $null
    }

    $choice = $routes[0].Id

    if ($script:Interactive) {
        Write-Host ''
        Write-Host '    Install it first?' -ForegroundColor White
        $i = 0
        foreach ($rt in $routes) {
            $i++
            Write-Host ("      {0}) {1}" -f $i, $rt.Command) -ForegroundColor Gray
            Write-Host ("         {0}" -f $rt.Why) -ForegroundColor DarkGray
        }
        $i++
        Write-Host ("      {0}) continue without gum (plain prompts)" -f $i) -ForegroundColor Gray
        $answer = Read-Host ("    Choose [1-{0}] (Enter = {1})" -f $i, $choice)
        if ($answer -and $answer.Trim()) {
            $n = 0
            if ([int]::TryParse($answer.Trim(), [ref]$n)) {
                if ($n -ge 1 -and $n -le $routes.Count) { $choice = $routes[$n - 1].Id }
                elseif ($n -eq $routes.Count + 1)       { return $null }
            }
        }
    }
    else {
        Say "(no interactive console - trying '$choice', the default route)"
    }

    $route = $routes | Where-Object { $_.Id -eq $choice } | Select-Object -First 1

    if ($DryRun) {
        Say "would run: $($route.Command)"
    }
    else {
        Say "running: $($route.Command)"
        $r = Invoke-Native -Exe 'cmd' -Arguments @('/c', $route.Command)
        if ($r.ExitCode -ne 0) {
            $fix = 'go install github.com/charmbracelet/gum@latest'
            if ($choice -eq 'go') { $fix = 'winget install charmbracelet.gum' }
            Warn "that failed (exit $($r.ExitCode)) - gum is optional, carrying on without it."
            Warn "  to try again:  $fix"
            return $null
        }
    }

    # go install drops the binary in $(go env GOPATH)\bin, which is frequently
    # not on PATH. Look there explicitly before giving up on it.
    if (-not $DryRun) {
        $found = Find-Gum
        if (-not $found) {
            $goExe = Resolve-Tool 'go'
            if ($goExe) {
                $gopath = Get-NativeText $goExe @('env', 'GOPATH')
                if ($gopath.ExitCode -eq 0 -and $gopath.Text) {
                    $cand = Join-Path $gopath.Text 'bin\gum.exe'
                    if ((Test-Path $cand) -and (Test-CharmGum $cand)) {
                        $found = $cand
                        $binDir = Split-Path $cand -Parent
                        if (($env:PATH -split ';') -notcontains $binDir) {
                            $env:PATH = $env:PATH + ';' + $binDir
                            Warn "$binDir is not on your PATH; added for this session only."
                            Warn "  to keep it:  setx PATH `"`$env:PATH;$binDir`"   (then open a new terminal)"
                        }
                    }
                }
            }
        }
        if ($found) {
            Ok "gum ready ($found)"
            return $found
        }
        Warn 'gum did not turn up after installing - carrying on without it.'
        return $null
    }

    return $null
}

# ---------------------------------------------------------------------------
# step runner
# ---------------------------------------------------------------------------

function Invoke-InstallStep {
    param(
        [string]$Title,
        [string]$Command,
        [string]$WorkDir,
        [string]$Fix
    )

    $script:StepNo++
    $n = $script:StepNo

    if ($DryRun) {
        Say ("{0}. would run: {1}   (in {2})" -f $n, $Command, $WorkDir)
        return $true
    }

    Write-Host ''
    Write-Host ("  {0}. {1}" -f $n, $Title) -ForegroundColor White

    if ($script:Gum) {
        # gum spin hides the child's output, so send it to a log: a failure can
        # then be explained without re-running a step that just failed.
        $log     = Join-Path $env:TEMP ("mnemo-install-{0}.log" -f $n)
        $wrapper = Join-Path $env:TEMP ("mnemo-install-{0}.cmd" -f $n)
        $body = @(
            '@echo off'
            ('cd /d "{0}"' -f $WorkDir)
            ('{0} > "{1}" 2>&1' -f $Command, $log)
        ) -join "`r`n"
        Set-Content -LiteralPath $wrapper -Value $body -Encoding ASCII

        $r = Invoke-Native -Exe $script:Gum -Arguments @('spin', '--spinner', 'dot', '--title', $Title, '--', 'cmd', '/c', $wrapper)

        if ($r.ExitCode -ne 0) {
            Bad "$Title - failed (exit $($r.ExitCode))"
            if (Test-Path $log) {
                $lines = @(Get-Content -LiteralPath $log -ErrorAction SilentlyContinue)
                $last = @($lines | Select-Object -Last 15)
                if ($last.Count -gt 0) {
                    Tail '--- last lines of the output ---'
                    foreach ($l in $last) { Tail ([string]$l) }
                    Tail "--- full log: $log ---"
                }
            }
            Warn "  to fix:  $Fix"
            return $false
        }

        Ok $Title
        Remove-Item -LiteralPath $wrapper -Force -ErrorAction SilentlyContinue
        return $true
    }

    $r = Invoke-Native -Exe 'cmd' -Arguments @('/c', $Command) -WorkDir $WorkDir
    if ($r.ExitCode -ne 0) {
        Bad "$Title - failed (exit $($r.ExitCode))"
        Warn "  to fix:  $Fix"
        return $false
    }
    Ok $Title
    return $true
}

# ===========================================================================
# 0. banner
# ===========================================================================

Write-Host ''
Write-Host '  Mnemo installer' -ForegroundColor White
Write-Host '  ---------------' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  This touches: this checkout (node_modules, target\, mnemo.exe), the' -ForegroundColor Gray
Write-Host '  install directory you choose, and your user PATH if you ask for it.' -ForegroundColor Gray
Write-Host '  It does not touch what is already inside ~\.mnemo - your keys and' -ForegroundColor Gray
Write-Host '  sessions - nor any other program, nor git state.' -ForegroundColor Gray

# ===========================================================================
# 1. preflight
# ===========================================================================

Step 'Preflight'

foreach ($d in @('agent', 'memory-layer', 'tui-go', 'harness-engine')) {
    if (-not (Test-Path (Join-Path $Root $d))) {
        Write-Host ''
        Bad "$Root does not look like the Mnemo repository (no $d\)."
        Warn '  to fix:  git clone https://github.com/AtmanMishra/self-evolving-agent'
        exit 1
    }
}

$gitExe   = Resolve-Tool 'git'
$nodeExe  = Resolve-Tool 'node'
$npmExe   = Resolve-Tool 'npm'
$goExe    = Resolve-Tool 'go'
$cargoExe = Resolve-Tool 'cargo'

$gitV = ''; $nodeV = ''; $npmV = ''; $goV = ''; $cargoV = ''

if ($gitExe)   { $t = Get-NativeText $gitExe @('--version');    $gitV   = ($t.Text -replace '^git version\s*', '').Trim() }
if ($nodeExe)  { $t = Get-NativeText $nodeExe @('-p', 'process.versions.node'); $nodeV = $t.Text }
if ($npmExe)   { $t = Get-NativeText $npmExe @('--version');    $npmV   = $t.Text }
if ($goExe)    { $t = Get-NativeText $goExe @('version');       $m = [regex]::Match($t.Text, 'go(\d+\.\d+(?:\.\d+)?)'); if ($m.Success) { $goV = $m.Groups[1].Value } }
if ($cargoExe) { $t = Get-NativeText $cargoExe @('--version');  $m = [regex]::Match($t.Text, 'cargo\s+(\S+)'); if ($m.Success) { $cargoV = $m.Groups[1].Value } }

$nodeOk = ($nodeExe -and (Test-MinVersion $nodeV $NodeFloor))
$goOk   = ($goExe -and (Test-MinVersion $goV $GoFloor))

# cargo alone does not promise a Windows build: linking the sidecar needs the
# MSVC toolchain, which usually arrives with Visual Studio Build Tools.
$hasMsvc = (Test-Path (Join-Path $env:ProgramFiles 'Microsoft Visual Studio\2022'))

$rows = @()
$rows += [pscustomobject]@{ Tool = 'git';   Status = $(if ($gitExe)   { 'ok' } else { 'missing' }); Version = $gitV;   Need = '-';                    Purpose = 'checkout and history' }
$rows += [pscustomobject]@{ Tool = 'node';  Status = $(if ($nodeOk)   { 'ok' } else { 'too low' }); Version = $nodeV;  Need = ">= $NodeFloor (hard)"; Purpose = 'runs the agent .ts directly' }
$rows += [pscustomobject]@{ Tool = 'npm';   Status = $(if ($npmExe)   { 'ok' } else { 'missing' }); Version = $npmV;   Need = 'present (hard)';       Purpose = 'agent and harness deps' }
$rows += [pscustomobject]@{ Tool = 'go';    Status = $(if ($goOk)     { 'ok' } else { 'too low' }); Version = $goV;    Need = ">= $GoFloor (hard)";   Purpose = 'builds the interface' }
$rows += [pscustomobject]@{ Tool = 'cargo'; Status = $(if ($cargoExe) { 'ok' } else { 'missing' }); Version = $cargoV; Need = 'optional';            Purpose = 'memory sidecar' }

Write-Host ''
Write-Host ('    {0} {1} {2} {3} {4}' -f (Pad-Text 'TOOL' 8), (Pad-Text 'STATUS' 9), (Pad-Text 'VERSION' 18), (Pad-Text 'REQUIRED' 16), 'PURPOSE') -ForegroundColor White
Write-Host ('    {0} {1} {2} {3} {4}' -f ('-' * 7), ('-' * 8), ('-' * 17), ('-' * 15), ('-' * 20)) -ForegroundColor DarkGray
foreach ($row in $rows) {
    $colour = 'Gray'
    if ($row.Status -ne 'ok') { $colour = 'Yellow' }
    Write-Host ('    {0} {1} {2} {3} {4}' -f (Pad-Text $row.Tool 8), (Pad-Text $row.Status 9), (Pad-Text $row.Version 18), (Pad-Text $row.Need 16), $row.Purpose) -ForegroundColor $colour
}

$prebuiltExe = Join-Path $Root 'tui-go\mnemo.exe'

# --- hard requirements: stop, and name the command that fixes it -----------

$hard = @()

if (-not $nodeExe) {
    $hard += @{ What = 'node is not on PATH.'; Fix = 'winget install OpenJS.NodeJS' }
}
elseif (-not $nodeOk) {
    $hard += @{
        What = "node $nodeV is too old. Mnemo runs TypeScript with no build step, which needs $NodeFloor+ - below that every .ts file in agent\ dies with ERR_UNKNOWN_FILE_EXTENSION."
        Fix  = "winget install OpenJS.NodeJS   (or:  nvm install $NodeFloor)"
    }
}

if (-not $npmExe) {
    $hard += @{ What = 'npm is not on PATH.'; Fix = 'winget install OpenJS.NodeJS   (npm ships with Node)' }
}

if (-not $goExe -and -not (Test-Path $prebuiltExe)) {
    $hard += @{
        What = 'go is not on PATH, and there is no prebuilt tui-go\mnemo.exe to fall back on.'
        Fix  = 'winget install GoLang.Go   (or put a release binary at tui-go\mnemo.exe)'
    }
}
elseif ($goExe -and -not $goOk) {
    $hard += @{ What = "go $goV is too old; the interface needs $GoFloor+."; Fix = 'winget install GoLang.Go' }
}

if ($hard.Count -gt 0) {
    Write-Host ''
    Write-Host 'FAIL  this machine is missing something Mnemo cannot run without:' -ForegroundColor Red
    foreach ($h in $hard) {
        Bad $h.What
        Warn "  to fix:  $($h.Fix)"
    }
    Write-Host ''
    exit 1
}

Ok "node $nodeV, npm $npmV, go $goV"

if (-not $cargoExe) {
    Write-Host ''
    Warn 'cargo not found - the memory sidecar cannot be built. It is optional:'
    Warn '  skip it and the Memory pane stays offline; nothing else changes.'
    Warn '  to add it:  https://rustup.rs  - on Windows that also needs the MSVC toolchain:'
    Warn '              winget install Microsoft.VisualStudio.2022.BuildTools'
}
elseif (-not $hasMsvc) {
    Write-Host ''
    Warn "cargo $cargoV is present, but Visual Studio 2022 was not found, and a Rust build"
    Warn '  on Windows needs the MSVC linker.'
    Warn '  to fix:  winget install Microsoft.VisualStudio.2022.BuildTools'
}

# ===========================================================================
# 2. gum
# ===========================================================================

Step 'Menus (gum)'

if ($env:MNEMO_NO_GUM) {
    Say 'MNEMO_NO_GUM is set - not looking for gum and not installing it.'
    $script:Gum = $null
}
else {
    $script:Gum = Find-Gum

    if ($script:Gum) {
        $t = Get-NativeText $script:Gum @('--version')
        Ok "gum found: $($t.Text)"
    }
    else {
        $found = Install-Gum
        if ($found) { $script:Gum = $found }
    }
}

# Interactivity is decided HERE - after -Yes/-DryRun are known and after gum
# exists - and before any interactive widget could be reached.
$consoleOk = Test-ConsoleAvailable
$script:Interactive = ((-not $Yes) -and (-not $DryRun) -and $consoleOk)

if (-not $script:Interactive) {
    if ($Yes)        { Say '-Yes given: taking the defaults, nothing will prompt.' }
    elseif ($DryRun) { Say '-DryRun given: nothing will run and nothing will prompt.' }
    else             { Warn 'no interactive console (input or output is redirected); taking the defaults.' }
}

if (-not $script:Gum) {
    Write-Host ''
    if ($env:MNEMO_NO_GUM) { Warn 'MNEMO_NO_GUM is set - using plain PowerShell prompts.' }
    else                   { Warn 'no gum - using plain PowerShell prompts. Every choice below still exists.' }
}
elseif (-not $consoleOk) {
    Write-Host ''
    Warn 'gum is installed, but this console is not interactive (input or output is'
    Warn '  redirected). gum choose/confirm/input hang forever in that situation, so'
    Warn '  they are not used; the same defaults are taken instead.'
}

# ===========================================================================
# 3. components
# ===========================================================================

Step 'What to install'

$components = @()

$interfaceAvail = ($goOk -or (Test-Path $prebuiltExe))
$interfaceWhy   = 'go build -o mnemo.exe ./cmd/mnemo   - the terminal interface'
if (-not $goOk -and (Test-Path $prebuiltExe)) { $interfaceWhy = 'prebuilt tui-go\mnemo.exe is present - no Go toolchain needed' }
if (-not $interfaceAvail)                    { $interfaceWhy = 'go is unavailable and there is no prebuilt tui-go\mnemo.exe' }
$components += [pscustomobject]@{ Id = 'interface'; Label = 'interface (Go)';         Why = $interfaceWhy; Available = $interfaceAvail; Selected = $interfaceAvail }

$components += [pscustomobject]@{ Id = 'agent';     Label = 'agent runtime (npm)';    Why = 'npm install   (in agent\)';        Available = $true; Selected = $true }

$memAvail = ($null -ne $cargoExe)
$memWhy   = 'cargo build --bin memsrv   (in memory-layer\)'
if (-not $memAvail)      { $memWhy = 'cargo is not installed - get it from https://rustup.rs (needs the MSVC toolchain on Windows)' }
elseif (-not $hasMsvc)   { $memWhy = 'cargo build --bin memsrv   (in memory-layer\) - no VS 2022 found, so the link step may fail' }
$components += [pscustomobject]@{ Id = 'memory';    Label = 'memory sidecar (cargo)'; Why = $memWhy; Available = $memAvail; Selected = $memAvail }

$components += [pscustomobject]@{ Id = 'harness';   Label = 'harness engine (npm)';   Why = 'npm install   (in harness-engine\)'; Available = $true; Selected = $true }
$components += [pscustomobject]@{ Id = 'path';      Label = 'PATH integration';       Why = "add the install directory to your user PATH ($InstallDir)"; Available = $true; Selected = $true }

$chosen = Ask-MultiSelect 'Which components?' $components

$doInterface = ($chosen -contains 'interface')
$doAgent     = ($chosen -contains 'agent')
$doMemory    = ($chosen -contains 'memory')
$doHarness   = ($chosen -contains 'harness')
$doPath      = ($chosen -contains 'path')

# ===========================================================================
# 4. install location
# ===========================================================================

Step 'Where to put the binary'

$InstallDir = Ask-Input 'Install directory' $InstallDir
# Normalise, so a forward-slash or relative answer cannot leave a PATH entry
# that looks wrong or defeats the "already present" check further down.
try { $InstallDir = [System.IO.Path]::GetFullPath($InstallDir) } catch { }
Say "install directory: $InstallDir"

$needsAdmin = $false
foreach ($p in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:windir)) {
    if ($p -and $InstallDir.ToLower().StartsWith($p.ToLower())) { $needsAdmin = $true }
}

if ($needsAdmin) {
    Write-Host ''
    Warn "$InstallDir is under a system directory, so writing there needs administrator rights."

    $isAdmin = $false
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $pr = New-Object Security.Principal.WindowsPrincipal($id)
        $isAdmin = $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    catch { $isAdmin = $false }

    if (-not $isAdmin) {
        Warn '  this shell is not elevated. Re-run PowerShell as Administrator, or pick'
        Warn ("  a per-user directory (the default is {0})" -f (Join-Path $env:LOCALAPPDATA 'Programs\mnemo'))
        if (-not (Ask-Confirm 'Continue anyway?' $false)) {
            Write-Host ''
            Say 'stopped at your request. Nothing was changed.'
            exit 1
        }
    }
    else {
        Ok 'this shell is elevated, so that is fine'
    }
}
else {
    Ok 'no elevation needed - that is a per-user directory'
}

# ~\.mnemo holds user data. Create it if it is missing; never touch anything
# already in it.
$mnemoHome = Join-Path $HOME '.mnemo'
if (Test-Path $mnemoHome) {
    Ok "$mnemoHome already exists - left untouched"
}
elseif ($DryRun) {
    Say "would run: create $mnemoHome (empty - your keys and sessions land there on first run)"
}
else {
    New-Item -ItemType Directory -Force -Path $mnemoHome | Out-Null
    Ok "created $mnemoHome (empty - first run will fill it)"
}

# ===========================================================================
# 5. confirm
# ===========================================================================

Step 'About to run'

$agentDir   = Join-Path $Root 'agent'
$memDir     = Join-Path $Root 'memory-layer'
$harnessDir = Join-Path $Root 'harness-engine'
$tuiDir     = Join-Path $Root 'tui-go'
$sourceExe  = Join-Path $tuiDir 'mnemo.exe'
$targetExe  = Join-Path $InstallDir 'mnemo.exe'

$plan = @()
$n = 0

if ($doAgent)                { $n++; $plan += ('{0}. npm install --silent                    (in agent\)' -f $n) }
if ($doMemory)               { $n++; $plan += ('{0}. cargo build --bin memsrv                (in memory-layer\)' -f $n) }
if ($doHarness)              { $n++; $plan += ('{0}. npm install --silent                    (in harness-engine\)' -f $n) }
if ($doInterface -and $goOk) { $n++; $plan += ('{0}. go build -o mnemo.exe ./cmd/mnemo      (in tui-go\)' -f $n) }
if ($doInterface)            { $n++; $plan += ('{0}. copy mnemo.exe -> {1}' -f $n, $targetExe) }
if ($doPath)                 { $n++; $plan += ('{0}. add {1} to your user PATH' -f $n, $InstallDir) }
$n++; $plan += ('{0}. verify: mnemo --version  and  mnemo --dump --rows 20 --cols 80' -f $n)

foreach ($line in $plan) { Say $line }

if (-not ($doAgent -or $doMemory -or $doHarness -or $doInterface)) {
    Write-Host ''
    Warn 'nothing was selected to install - stopping.'
    exit 1
}

Write-Host ''
if ($script:Interactive) {
    if (-not (Ask-Confirm 'Proceed?' $true)) {
        Write-Host ''
        Say 'stopped at your request. Nothing was changed.'
        exit 0
    }
}
else {
    Say '(non-interactive: proceeding)'
}

# ===========================================================================
# 6. execute
# ===========================================================================

Step 'Installing'

if ($doAgent) {
    $ok = Invoke-InstallStep -Title 'Installing the agent runtime (agent\)' -Command 'npm install --silent' -WorkDir $agentDir -Fix 'cd agent; npm install   (check access to the npm registry)'
    if (-not $ok) { $script:Failures += 'agent runtime (agent\): npm install' }
}

if ($doMemory) {
    $ok = Invoke-InstallStep -Title 'Building the memory sidecar (memory-layer\)' -Command 'cargo build --bin memsrv' -WorkDir $memDir -Fix 'winget install Microsoft.VisualStudio.2022.BuildTools   then re-run this script'
    if (-not $ok) {
        $script:Failures += 'memory sidecar (memory-layer\): cargo build --bin memsrv'
        $script:NotDone  += 'the memory sidecar - the Memory pane will stay offline'
    }
}

if ($doHarness) {
    $ok = Invoke-InstallStep -Title 'Installing the harness engine (harness-engine\)' -Command 'npm install --silent' -WorkDir $harnessDir -Fix 'cd harness-engine; npm install'
    if (-not $ok) { $script:Failures += 'harness engine (harness-engine\): npm install' }
}

if ($doInterface -and $goOk) {
    $ok = Invoke-InstallStep -Title 'Building the interface (tui-go\)' -Command 'go build -o mnemo.exe ./cmd/mnemo' -WorkDir $tuiDir -Fix 'cd tui-go; go mod download; go build -o mnemo.exe ./cmd/mnemo'
    if (-not $ok) { $script:Failures += 'interface (tui-go\): go build' }
}

if ($doInterface) {
    if ($DryRun) {
        # Nothing ran, so nothing was built. Report the copy that would happen
        # rather than checking for a binary DryRun was never going to produce.
        Say ("would run: copy {0} -> {1}" -f $sourceExe, $targetExe)
    }
    elseif (-not (Test-Path $sourceExe)) {
        Write-Host ''
        Bad "no binary at $sourceExe - nothing to install"
        Warn '  to fix:  cd tui-go; go build -o mnemo.exe ./cmd/mnemo'
        Warn '      or:  put a release binary at tui-go\mnemo.exe'
        $script:Failures += 'install binary: nothing was built'
        $script:NotDone  += 'the interface binary'
    }
    else {
        $script:StepNo++
        Write-Host ''
        Write-Host ("  {0}. Installing to {1}" -f $script:StepNo, $InstallDir) -ForegroundColor White

        # Copy through a child process rather than PowerShell's own file APIs.
        # Endpoint protection with behaviour monitoring can taint an executable
        # that powershell.exe wrote itself and then refuse to launch it: on a
        # Trend Micro Apex One machine, Copy-Item and [IO.File]::Copy both
        # produced a binary that would not start, while `cmd /c copy` produced
        # one that ran. Byte-identical either way. So the copy goes through cmd.
        try {
            New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
        }
        catch {
            Bad "could not create $InstallDir"
            Warn ("  to fix:  pick a writable directory, e.g. {0}" -f (Join-Path $env:LOCALAPPDATA 'mnemo'))
            Warn '            a directory under Program Files needs an Administrator shell'
            $script:Failures += 'install binary: the install directory could not be created'
            $script:NotDone  += 'the interface binary'
            $InstallDir = $null
        }

        if ($InstallDir) {
            $copyCmd = 'copy /Y "{0}" "{1}"' -f $sourceExe, $targetExe
            $rc = Invoke-Native -Exe 'cmd' -Arguments @('/c', $copyCmd) -Capture
            if ($rc.ExitCode -eq 0 -and (Test-Path $targetExe)) {
                Ok $targetExe
            }
            else {
                Bad "could not copy the binary to $InstallDir"
                foreach ($line in @($rc.Output | Select-Object -Last 5)) { Tail ([string]$line) }
                Warn ("  to fix:  pick a writable directory, e.g. {0}" -f (Join-Path $env:LOCALAPPDATA 'mnemo'))
                Warn '            a directory under Program Files needs an Administrator shell'
                $script:Failures += 'install binary: the copy failed'
                $script:NotDone  += 'the interface binary'
            }
        }
    }
}

if ($doPath) {
    if ($DryRun) {
        Say "would run: add $InstallDir to your user PATH"
    }
    else {
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if (-not $userPath) { $userPath = '' }
        if (($userPath -split ';') -contains $InstallDir) {
            Ok "$InstallDir is already on your user PATH"
        }
        else {
            try {
                $newPath = $userPath.TrimEnd(';')
                if ($newPath) { $newPath = $newPath + ';' + $InstallDir }
                else          { $newPath = $InstallDir }
                [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
                Ok "added $InstallDir to your user PATH (open a new terminal to pick it up)"
            }
            catch {
                Bad 'could not update your user PATH'
                Warn "  to fix:  run this in PowerShell:  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';$InstallDir', 'User')"
                $script:Failures += 'PATH integration'
            }
        }
    }
}

# ===========================================================================
# 7. verify
# ===========================================================================

Step 'Verifying'

if ($DryRun) {
    Say "would run: $targetExe --version"
    Say "would run: $targetExe --dump --rows 20 --cols 80"
    Say '(both must exit 0, and the frame has to render)'
}
elseif (-not (Test-Path $targetExe)) {
    Bad "cannot verify: $targetExe does not exist"
    Warn '  to fix:  re-run this script with the interface component selected'
    $script:Failures += 'verify: there was no binary to verify'
    $script:NotDone  += 'verification - nothing was installed to check'
}
else {
    $v = Get-NativeText $targetExe @('--version')
    if ($v.ExitCode -eq 0) {
        Ok "mnemo --version -> $($v.Text)"
    }
    else {
        Bad "mnemo --version failed (exit $($v.ExitCode))"
        Show-LaunchBlockedHint @($v.Text)
        Warn '  to fix:  re-run this script; if it repeats, report it at https://github.com/AtmanMishra/self-evolving-agent/issues'
        $script:Failures += 'verify: mnemo --version'
    }

    $d = Invoke-Native -Exe $targetExe -Arguments @('--dump', '--rows', '20', '--cols', '80') -Capture
    if ($d.ExitCode -eq 0) {
        Ok 'mnemo --dump --rows 20 --cols 80 -> exit 0; the top of the frame it rendered:'
        Write-Host ''
        foreach ($line in @($d.Output | Select-Object -First 12)) {
            Write-Host ('  | ' + [string]$line) -ForegroundColor DarkGray
        }
        Write-Host ''
    }
    else {
        Bad "mnemo --dump failed (exit $($d.ExitCode))"
        foreach ($line in @($d.Output | Select-Object -Last 10)) { Tail ([string]$line) }
        Show-LaunchBlockedHint $d.Output
        Warn '  to fix:  re-run this script; if it repeats, report it at https://github.com/AtmanMishra/self-evolving-agent/issues'
        $script:Failures += 'verify: mnemo --dump'
    }
}

# ===========================================================================
# 8. next steps
# ===========================================================================

Step 'Next steps'

$lines = @(
    ("the binary:  {0}" -f $targetExe),
    ("run it:      `"{0}`" --repo {1}" -f $targetExe, $Root),
    'first run:   /login picks a provider and takes your API key',
    '             /model lists what those providers offer',
    ("version:     `"{0}`" --version" -f $targetExe)
)

if ($script:Gum -and -not $DryRun) {
    & $script:Gum style --border rounded --border-foreground 212 --padding '0 2' --margin '1 0' $lines
}
else {
    Write-Host ''
    foreach ($l in $lines) { Write-Host "    $l" -ForegroundColor Gray }
}

if ($script:NotDone.Count -gt 0) {
    Write-Host ''
    Warn 'not done:'
    foreach ($nd in $script:NotDone) { Warn "  - $nd" }
}

if ($script:Failures.Count -gt 0) {
    Write-Host ''
    Write-Host 'FAILED - these steps did not complete:' -ForegroundColor Red
    $i = 0
    foreach ($f in $script:Failures) { $i++; Write-Host ("  {0}. {1}" -f $i, $f) -ForegroundColor Red }
    Write-Host ''
    Warn 'everything else did complete. Fix the above and re-run - this script is safe'
    Warn '  to run again; it does not redo work that is already done.'
    Write-Host ''
    exit 1
}

Write-Host ''
Write-Host '  Done.' -ForegroundColor Green
Write-Host ''
exit 0
