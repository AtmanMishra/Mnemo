#Requires -Version 5.1
<#
  Install Mnemo from a GitHub release on Windows: mnemo.exe and memsrv.exe
  into $env:MNEMO_HOME\bin (default ~\.mnemo\bin), added to the user PATH.

    irm https://github.com/AtmanMishra/self-evolving-agent/releases/latest/download/install.ps1 | iex

  Environment: MNEMO_VERSION (a tag), MNEMO_HOME, MNEMO_RELEASE_BASE (a mirror
  or a local folder). Running it again upgrades in place; memory, sessions and
  settings are never touched.
#>
$ErrorActionPreference = "Stop"
$Repo = "AtmanMishra/self-evolving-agent"
$HomeDir = if ($env:MNEMO_HOME) { $env:MNEMO_HOME } else { Join-Path $HOME ".mnemo" }
$BinDir = Join-Path $HomeDir "bin"

$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { throw "mnemo needs 64-bit Windows" }
$platform = "windows-$arch"
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
  $want = (Get-Content (Join-Path $tmp "SHA256SUMS") | Where-Object { $_ -match " $([regex]::Escape($archive))$" }) -replace " .*", ""
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
  Write-Host "done — run: mnemo"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
