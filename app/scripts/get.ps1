#Requires -Version 5.1
<#
  Install Mnemo on Windows: mnemo.exe and memsrv.exe into $env:MNEMO_HOME\bin
  (default ~\.mnemo\bin), added to the user PATH. No Bun, Node, Rust or Python needed.

    irm https://github.com/AtmanMishra/Mnemo/releases/latest/download/install.ps1 | iex

  Environment (set before running):
    MNEMO_VERSION       a tag (v0.1.0) instead of the latest release
    MNEMO_HOME          where Mnemo lives (default ~\.mnemo)
    MNEMO_RELEASE_BASE  a mirror, or a local folder, holding the archive
    MNEMO_REPO          owner/name of the GitHub repository (default AtmanMishra/Mnemo)
    MNEMO_UNINSTALL=1   remove the binaries and the PATH entry (memory and sessions stay)
    MNEMO_UNINSTALL=deep  also delete MNEMO_HOME: memory, sessions, credentials, skills,
                        logs, settings (asks you to type "delete" first)
    MNEMO_YES=1         do not ask (for scripts)
    NO_COLOR=1          plain output, no animation

  Running it again upgrades in place; memory, sessions and settings are never
  touched. The archive's SHA-256 is checked against the release's SHA256SUMS
  before anything is installed.

  Everything is inside a function that is called on the last line, so a download
  that is cut off halfway fails to parse and runs nothing.
#>
function Install-Mnemo {
  $ErrorActionPreference = "Stop"
  $Repo = if ($env:MNEMO_REPO) { $env:MNEMO_REPO } else { "AtmanMishra/Mnemo" }
  $HomeDir = if ($env:MNEMO_HOME) { $env:MNEMO_HOME } else { Join-Path $HOME ".mnemo" }
  $BinDir = Join-Path $HomeDir "bin"
  $Version = $env:MNEMO_VERSION

  # These end up in a URL and a download: refuse anything that is not what it says.
  if ($Repo -notmatch '^[A-Za-z0-9_-][A-Za-z0-9._-]*/[A-Za-z0-9_-][A-Za-z0-9._-]*$') { throw "MNEMO_REPO must look like owner/name, not $Repo" }
  if ($Version -and $Version -notmatch '^v[0-9][A-Za-z0-9.+-]*$') { throw "MNEMO_VERSION must look like v0.1.0, not $Version" }
  if ($env:MNEMO_RELEASE_BASE -and $env:MNEMO_RELEASE_BASE -notmatch '^https://' -and -not (Test-Path $env:MNEMO_RELEASE_BASE)) { throw "MNEMO_RELEASE_BASE must be https:// or a local folder" }

  # The Path value is read raw so %VARIABLES% in it are kept, and an unset one is not made to start with ';'.
  function Get-UserPath {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment")
    try { if ($key) { return [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { return "" } } finally { if ($key) { $key.Close() } }
  }
  function Set-UserPath($value) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")
    try { $key.SetValue("Path", $value, [Microsoft.Win32.RegistryValueKind]::ExpandString) } finally { $key.Close() }
  }

  # The look: colour and a pulse on a console; plain lines when output is redirected or NO_COLOR is set.
  $Fancy = -not $env:NO_COLOR -and -not [Console]::IsOutputRedirected
  function Banner($what) {
    if (-not $Fancy) { Write-Host "mnemo $what"; return }
    Write-Host ""
    foreach ($row in @("█▀▄▀█ █▄ █ █▀▀ █▀▄▀█ █▀█", "█ ▀ █ █ ▀█ ██▄ █ ▀ █ █▄█")) { Write-Host "  $row" -ForegroundColor Magenta; Start-Sleep -Milliseconds 60 }
    Write-Host "  ◆───◆───◆ " -ForegroundColor Cyan -NoNewline; Write-Host $what -ForegroundColor DarkGray
    Write-Host ""
  }
  function Ok($text) { if ($Fancy) { Write-Host "  ✓ " -ForegroundColor Green -NoNewline; Write-Host $text } else { Write-Host "  ✓ $text" } }
  # Run a .NET task with a dither pulse beside its label (and the KB so far for a download), then ✓ or ✗.
  function Step($label, [scriptblock]$start, $watch) {
    if (-not $Fancy) { Write-Host "  $label"; $t = & $start; $t.GetAwaiter().GetResult() | Out-Null; return }
    $t = & $start
    $frames = "░", "▒", "▓", "█", "▓", "▒"; $n = 0
    while (-not $t.IsCompleted) {
      $kb = if ($watch -and (Test-Path $watch)) { " {0} KB" -f [int]((Get-Item $watch).Length / 1KB) } else { "" }
      Write-Host ("`r  " + $frames[$n % 6] + " ") -ForegroundColor Magenta -NoNewline; Write-Host ($label + $kb + "   ") -NoNewline
      Start-Sleep -Milliseconds 80; $n++
    }
    if ($t.IsFaulted) { Write-Host "`r  ✗ $label   " -ForegroundColor Red; throw $t.Exception.InnerException }
    Write-Host "`r  ✓ " -ForegroundColor Green -NoNewline; Write-Host "$label        "
  }
  # A folder is deleted whole only if it is plainly Mnemo's: not your home, and holding only what Mnemo puts there.
  function Test-MnemoHome($dir) {
    if (-not (Test-Path $dir)) { return $false }
    $full = (Resolve-Path $dir).Path.TrimEnd("\")
    if ($full -eq (Resolve-Path $HOME).Path.TrimEnd("\") -or $full.Length -le 3) { return $false }
    $known = "state.json", "agent", "memory", "bin", "logs", "kernel", "best-of", "permissions.json", "grants.json", "skill-history", "journal.jsonl"
    $items = Get-ChildItem -Force $dir
    if (-not $items) { return $false }
    foreach ($i in $items) { if ($known -notcontains $i.Name -and -not $i.Name.StartsWith(".") -and -not $i.Name.StartsWith("state.json")) { return $false } }
    return $true
  }

  if ($env:MNEMO_UNINSTALL -and $env:MNEMO_UNINSTALL -notin "0", "false", "no") {
    $deep = $env:MNEMO_UNINSTALL -eq "deep"
    Banner "uninstall"
    if ($deep) {
      if (-not (Test-MnemoHome $HomeDir)) { throw "$HomeDir does not look like Mnemo's folder (it holds other files); not deleting it. Remove what you want by hand." }
      Write-Host "  this deletes ${HomeDir}: memory, sessions, credentials, skills, logs and settings"
      if (-not $env:MNEMO_YES) {
        $answer = Read-Host '  type "delete" to go ahead'
        if ($answer -ne "delete") { Write-Host "  nothing changed"; return }
      }
    }
    foreach ($f in "mnemo.exe", "memsrv.exe", "*.old", "*.new") { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $BinDir $f) }
    if (Test-Path (Join-Path $BinDir "mnemo.exe")) { throw "mnemo.exe is in use: close every Mnemo window and run this again" }
    $kept = ((Get-UserPath) -split ";" | Where-Object { $_ -and $_ -ne $BinDir }) -join ";"
    Set-UserPath $kept
    Ok "removed mnemo and memsrv, and $BinDir from your PATH"
    if ($deep) {
      Remove-Item -Recurse -Force $HomeDir
      Ok "deleted $HomeDir"
    } else {
      Write-Host "  your memory, sessions and settings are still in $HomeDir (MNEMO_UNINSTALL=deep deletes them too)"
    }
    Write-Host "  if you attached memory to Claude Code or Codex (mnemo memory setup), remove the mnemo entries from their settings"
    return
  }

  if (-not [Environment]::Is64BitOperatingSystem) { throw "mnemo needs 64-bit Windows" }
  $platform = "windows-x64"
  $archive = "mnemo-$platform.zip"
  $base = if ($env:MNEMO_RELEASE_BASE) { $env:MNEMO_RELEASE_BASE }
          elseif ($Version) { "https://github.com/$Repo/releases/download/$Version" }
          else { "https://github.com/$Repo/releases/latest/download" }

  # TLS 1.2 for github.com on Windows PowerShell 5.1's older defaults.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  function Fetch($from, $to) {
    if (Test-Path $from) { Copy-Item $from $to } else { (New-Object Net.WebClient).DownloadFile($from, $to) }
  }

  Banner "installer · $platform"
  if ($env:MNEMO_RELEASE_BASE) { Write-Host "  ! downloading from $base instead of github.com/${Repo}: only continue if you chose that" }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("mnemo-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $dest0 = Join-Path $tmp $archive
    if (Test-Path "$base/$archive") { Copy-Item "$base/$archive" $dest0; Ok "copied $archive" }
    else { Step "downloading $archive" { (New-Object Net.WebClient).DownloadFileTaskAsync("$base/$archive", $dest0) } $dest0 }
    Fetch "$base/SHA256SUMS" (Join-Path $tmp "SHA256SUMS")
    $want = (Get-Content (Join-Path $tmp "SHA256SUMS") | Where-Object { $_ -match " \*?$([regex]::Escape($archive))$" }) -replace " .*", ""
    if (-not $want) { throw "$archive is not in SHA256SUMS" }
    # .NET rather than Get-FileHash: some PowerShell hosts have no Microsoft.PowerShell.Utility on the module path.
    $sha = [Security.Cryptography.SHA256]::Create()
    $fs = [IO.File]::OpenRead((Join-Path $tmp $archive))
    try { $got = ([BitConverter]::ToString($sha.ComputeHash($fs)) -replace "-", "").ToLower() } finally { $fs.Dispose(); $sha.Dispose() }
    if ($want -ne $got) { throw "checksum mismatch for $archive" }
    Ok "checksum"
    # Take the two files we expect by name, never a path from inside the archive.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $tmp $archive))
    try {
      foreach ($f in "mnemo.exe", "memsrv.exe") {
        $entry = $zip.Entries | Where-Object { $_.FullName -eq $f } | Select-Object -First 1
        if (-not $entry) { throw "$archive does not hold $f" }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $tmp $f), $true)
      }
    } finally { $zip.Dispose() }
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    $names = "mnemo.exe", "memsrv.exe"
    # Copies left aside by earlier updates; one still running (an MCP server child, say) stays.
    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $BinDir "*.old")
    # Both new files go in beside the old ones first, so nothing installed has changed if this fails.
    foreach ($f in $names) { Copy-Item -Force (Join-Path $tmp $f) (Join-Path $BinDir "$f.new") }
    # A running .exe cannot be overwritten, but it can be renamed: each one in place is moved
    # aside under a name of its own (mnemo deletes *.old on its next start; a name is never
    # reused, since an earlier .old may still be running). If either cannot be moved, the
    # other is put back: never a new mnemo.exe beside an old memsrv.exe.
    $aside = @()
    try {
      foreach ($f in $names) {
        $dest = Join-Path $BinDir $f
        if (Test-Path $dest) {
          $old = "$dest." + [IO.Path]::GetRandomFileName().Replace(".", "") + ".old"
          Move-Item -ErrorAction Stop $dest $old
          $aside += [pscustomobject]@{ Old = $old; Dest = $dest }
        }
      }
    } catch {
      foreach ($a in $aside) { Move-Item -Force -ErrorAction SilentlyContinue $a.Old $a.Dest }
      foreach ($f in $names) { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $BinDir "$f.new") }
      throw "could not replace $f; close every Mnemo window and run the installer again"
    }
    foreach ($f in $names) { Move-Item -Force (Join-Path $BinDir "$f.new") (Join-Path $BinDir $f) }
    Ok "installed into $BinDir"
    $userPath = Get-UserPath
    if (($userPath -split ";") -notcontains $BinDir) {
      Set-UserPath ((@($userPath -split ";" | Where-Object { $_ }) + $BinDir) -join ";")
      Write-Host "  added $BinDir to your PATH (open a new terminal)"
    }
    & (Join-Path $BinDir "mnemo.exe") doctor
    # doctor exits 1 when no model is configured yet; that must not become the installer's exit code.
    $global:LASTEXITCODE = 0
    if ($Fancy) {
      Write-Host ""
      foreach ($row in @("  ▄▀▀▀▀▀▀▄", "▄▀▀████▀▀▄", "█▀██▀▀██▀█", " ▀▀████▀▀", "   ████")) { Write-Host "    $row" -ForegroundColor DarkMagenta; Start-Sleep -Milliseconds 50 }
      Write-Host "    " -NoNewline
      foreach ($i in 1..5) { Write-Host "◆" -ForegroundColor Yellow -NoNewline; if ($i -lt 5) { Write-Host "───" -ForegroundColor Cyan -NoNewline }; Start-Sleep -Milliseconds 70 }
      Write-Host "  Mne remembers." -ForegroundColor DarkGray
      Write-Host ""
    }
    Write-Host "done: run  mnemo   (open a new terminal first if it is not found)"
    Write-Host "      update:     mnemo update"
    Write-Host "      uninstall:  mnemo uninstall   (--deep also deletes memory, sessions and settings)"
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

Install-Mnemo
