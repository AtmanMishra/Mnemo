#Requires -Version 5.1
<#
  Install Mnemo on Windows: mnemo.exe and memsrv.exe into $env:MNEMO_HOME\bin
  (default ~\.mnemo\bin), added to the user PATH. No Bun, Node, Rust or Python needed.

    irm https://github.com/AtmanMishra/mnemo/releases/latest/download/install.ps1 | iex

  Environment (set before running):
    MNEMO_VERSION       a tag (v0.1.0) instead of the latest release
    MNEMO_HOME          where Mnemo lives (default ~\.mnemo)
    MNEMO_RELEASE_BASE  a mirror, or a local folder, holding the archive
    MNEMO_REPO          owner/name of the GitHub repository (default AtmanMishra/mnemo)
    MNEMO_UNINSTALL=1   remove the binaries and the PATH entry (memory and sessions stay)

  Running it again upgrades in place; memory, sessions and settings are never
  touched. The archive's SHA-256 is checked against the release's SHA256SUMS
  before anything is installed.

  Everything is inside a function that is called on the last line, so a download
  that is cut off halfway fails to parse and runs nothing.
#>
function Install-Mnemo {
  $ErrorActionPreference = "Stop"
  $Repo = if ($env:MNEMO_REPO) { $env:MNEMO_REPO } else { "AtmanMishra/mnemo" }
  $HomeDir = if ($env:MNEMO_HOME) { $env:MNEMO_HOME } else { Join-Path $HOME ".mnemo" }
  $BinDir = Join-Path $HomeDir "bin"

  if ($env:MNEMO_UNINSTALL) {
    foreach ($f in "mnemo.exe", "memsrv.exe") { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $BinDir $f) }
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $kept = ($userPath -split ";" | Where-Object { $_ -and $_ -ne $BinDir }) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $kept, "User")
    Write-Host "removed mnemo and memsrv"
    Write-Host "your memory, sessions and settings are still in $HomeDir (delete it to remove them too)"
    return
  }

  if (-not [Environment]::Is64BitOperatingSystem) { throw "mnemo needs 64-bit Windows" }
  $platform = "windows-x64"
  $archive = "mnemo-$platform.zip"
  $base = if ($env:MNEMO_RELEASE_BASE) { $env:MNEMO_RELEASE_BASE }
          elseif ($env:MNEMO_VERSION) { "https://github.com/$Repo/releases/download/$($env:MNEMO_VERSION)" }
          else { "https://github.com/$Repo/releases/latest/download" }

  function Fetch($from, $to) {
    if (Test-Path $from) { Copy-Item $from $to } else { Invoke-WebRequest -UseBasicParsing -Uri $from -OutFile $to }
  }

  Write-Host "mnemo installer · $platform"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("mnemo-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Fetch "$base/$archive" (Join-Path $tmp $archive)
    Fetch "$base/SHA256SUMS" (Join-Path $tmp "SHA256SUMS")
    $want = (Get-Content (Join-Path $tmp "SHA256SUMS") | Where-Object { $_ -match " \*?$([regex]::Escape($archive))$" }) -replace " .*", ""
    if (-not $want) { throw "$archive is not in SHA256SUMS" }
    $got = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $archive)).Hash.ToLower()
    if ($want -ne $got) { throw "checksum mismatch for $archive" }
    Write-Host "  ✓ checksum"
    Expand-Archive -Force (Join-Path $tmp $archive) $tmp
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    foreach ($f in "mnemo.exe", "memsrv.exe") { Move-Item -Force (Join-Path $tmp $f) (Join-Path $BinDir $f) }
    Write-Host "  ✓ installed into $BinDir"
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (($userPath -split ";") -notcontains $BinDir) {
      [Environment]::SetEnvironmentVariable("Path", "$userPath;$BinDir", "User")
      Write-Host "  added $BinDir to your PATH (open a new terminal)"
    }
    & (Join-Path $BinDir "mnemo.exe") doctor
    Write-Host "done: run  mnemo"
    Write-Host "      uninstall:  `$env:MNEMO_UNINSTALL=1; irm https://github.com/$Repo/releases/latest/download/install.ps1 | iex"
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

Install-Mnemo
