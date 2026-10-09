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

  if ($env:MNEMO_UNINSTALL -and $env:MNEMO_UNINSTALL -notin "0", "false", "no") {
    foreach ($f in "mnemo.exe", "memsrv.exe") { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $BinDir $f) }
    $kept = ((Get-UserPath) -split ";" | Where-Object { $_ -and $_ -ne $BinDir }) -join ";"
    Set-UserPath $kept
    Write-Host "removed mnemo and memsrv"
    Write-Host "your memory, sessions and settings are still in $HomeDir (delete it to remove them too)"
    return
  }

  if (-not [Environment]::Is64BitOperatingSystem) { throw "mnemo needs 64-bit Windows" }
  $platform = "windows-x64"
  $archive = "mnemo-$platform.zip"
  $base = if ($env:MNEMO_RELEASE_BASE) { $env:MNEMO_RELEASE_BASE }
          elseif ($Version) { "https://github.com/$Repo/releases/download/$Version" }
          else { "https://github.com/$Repo/releases/latest/download" }

  function Fetch($from, $to) {
    if (Test-Path $from) { Copy-Item $from $to } else { Invoke-WebRequest -UseBasicParsing -Uri $from -OutFile $to }
  }

  Write-Host "mnemo installer · $platform"
  if ($env:MNEMO_RELEASE_BASE) { Write-Host "  ! downloading from $base instead of github.com/${Repo}: only continue if you chose that" }
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
    foreach ($f in "mnemo.exe", "memsrv.exe") { Move-Item -Force (Join-Path $tmp $f) (Join-Path $BinDir $f) }
    Write-Host "  ✓ installed into $BinDir"
    $userPath = Get-UserPath
    if (($userPath -split ";") -notcontains $BinDir) {
      Set-UserPath ((@($userPath -split ";" | Where-Object { $_ }) + $BinDir) -join ";")
      Write-Host "  added $BinDir to your PATH (open a new terminal)"
    }
    & (Join-Path $BinDir "mnemo.exe") doctor
    # doctor exits 1 when no model is configured yet; that must not become the installer's exit code.
    $global:LASTEXITCODE = 0
    Write-Host "done: run  mnemo"
    Write-Host "      uninstall:  `$env:MNEMO_UNINSTALL=1; irm https://github.com/$Repo/releases/latest/download/install.ps1 | iex"
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

Install-Mnemo
