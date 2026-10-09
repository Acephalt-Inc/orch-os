# SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
# End-to-end install check. Runs in Windows PowerShell 5.1 and in PowerShell 7 (Windows, Linux, macOS).
#
# It packs this checkout with `npm pack`, installs the tarball with `npm install -g`, and then uses
# the installed `orch` command the way a new user does, against a throwaway ORCH_HOME: version,
# init, doctor, load, a note, a task, a message, the lease. Every exit code is checked; the first
# unexpected one stops the script with exit 1.
#
# It replaces any globally installed orch-os package. On every exit path it removes orch-os and
# its temporary folder. It is meant for CI machines. `npm pack` rebuilds dist/ in the checkout.

$ErrorActionPreference = "Continue"
$onWindows = $env:OS -eq "Windows_NT"
$root = Split-Path -Parent $PSScriptRoot
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("orch-e2e-" + [guid]::NewGuid().ToString("N"))
$failed = $false
function Fail([string]$message) {
  throw $message
}

# Run one command, print its exit code and output, and stop unless the exit code is the wanted one.
# Returns the command's standard output as one string.
function Step {
  param([int]$Want, [string]$Exe, [string[]]$Arguments)
  $out = & $Exe @Arguments
  $code = $LASTEXITCODE
  $shown = "$Exe $($Arguments -join ' ')"
  Write-Host "[e2e] exit $code (want $Want): $shown"
  $text = ""
  if ($null -ne $out) {
    $text = (@($out) -join "`n")
    foreach ($line in @($out)) { Write-Host "        $line" }
  }
  if ($code -ne $Want) { Fail $shown }
  return $text
}

function Expect([string]$text, [string]$needle, [string]$what) {
  if (-not $text.Contains($needle)) { Fail "$what does not contain '$needle'" }
}

try {
  New-Item -ItemType Directory -Path $work | Out-Null
  $env:ORCH_HOME = Join-Path $work "home"
  Remove-Item Env:ORCH_AGENT -ErrorAction SilentlyContinue
  Remove-Item Env:ORCH_SESSION_ID -ErrorAction SilentlyContinue
  Write-Host "[e2e] PowerShell $($PSVersionTable.PSVersion) on $(if ($onWindows) { 'Windows' } else { 'a POSIX system' }); ORCH_HOME=$($env:ORCH_HOME)"

  # 1. pack and install
  Set-Location $root
$null = Step 0 "npm" @("pack", "--pack-destination", $work)
$tarball = Get-ChildItem -Path $work -Filter "orch-os-*.tgz" | Select-Object -First 1
if ($null -eq $tarball) { Fail "npm pack left no tarball in $work" }
$null = Step 0 "npm" @("install", "-g", $tarball.FullName)
Set-Location $work

# 2. the installed command
$version = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
$text = Step 0 "orch" @("--version")
Expect $text "orch $version" "orch --version"
if ($onWindows) {
  # the same command through its .cmd file, and from cmd.exe
  $text = Step 0 "orch.cmd" @("--version")
  Expect $text "orch $version" "orch.cmd --version"
  $text = Step 0 "cmd.exe" @("/d", "/c", "orch --version")
  Expect $text "orch $version" "cmd.exe /c orch --version"
}

# 3. init and doctor (stdin is not a terminal here, so init asks nothing)
$text = Step 0 "orch" @("init")
Expect $text "next: orch doctor" "orch init"
if (-not (Test-Path (Join-Path $env:ORCH_HOME "config.toml"))) { Fail "orch init wrote no config.toml" }
if (-not (Test-Path (Join-Path $env:ORCH_HOME "handbook/protocols.md"))) { Fail "orch init wrote no handbook" }
$text = Step 0 "orch" @("doctor")
Expect $text "doctor: PASS (0 required check(s) failed)" "orch doctor"

# 4. load: Windows has no system signals; other systems only guarantee a successful sample
$text = Step 0 "orch" @("load")
if ($onWindows) {
  Expect $text "load_ratio=n/a" "orch load"
  Expect $text "swap=n/a" "orch load"
  Expect $text "temp=n/a" "orch load"
}

# 5. a note: add it, find it
$null = Step 0 "orch" @("mem", "add", "e2e-note", "-d", "written by the install check", "-m", "the body of the note")
$text = Step 0 "orch" @("mem", "search", "e2e-note")
Expect $text "e2e-note" "orch mem search"
Expect $text "written by the install check" "orch mem search"

# 6. a task: claim it, a second claim is refused, release it
$null = Step 0 "orch" @("task", "claim", "e2e-task", "--as", "alice")
$null = Step 3 "orch" @("task", "claim", "e2e-task", "--as", "bob")
$text = Step 0 "orch" @("task", "list")
Expect $text "e2e-task" "orch task list"
$null = Step 0 "orch" @("task", "release", "e2e-task", "--as", "alice")

# 7. a message: send it, read it as the addressee
$null = Step 0 "orch" @("msg", "send", "DONE", "--to", "bob", "--as", "alice", "-m", "hello from the install check")
$text = Step 0 "orch" @("msg", "read", "--as", "bob")
Expect $text "hello from the install check" "orch msg read"

# 8. the lease: acquire it, see the holder, a second session is refused
$null = Step 0 "orch" @("lease", "acquire", "--session", "alice")
$text = Step 0 "orch" @("lease", "status")
Expect $text "holder=alice" "orch lease status"
$null = Step 3 "orch" @("lease", "acquire", "--session", "bob")
$null = Step 0 "orch" @("lease", "release", "--session", "alice")

# 9. a note whose body arrives on standard input
$out = "the body came through a pipe" | & orch mem add e2e-piped -d "piped by the install check"
$code = $LASTEXITCODE
Write-Host "[e2e] exit $code (want 0): 'the body came through a pipe' | orch mem add e2e-piped -d ..."
if ($null -ne $out) { foreach ($line in @($out)) { Write-Host "        $line" } }
if ($code -ne 0) { Fail "piped orch mem add" }
$note = Get-Content (Join-Path $env:ORCH_HOME "mem/e2e-piped.md") -Raw
Expect $note "the body came through a pipe" "mem/e2e-piped.md"

# 10. Windows: the commands that are not available say so and exit 2
if ($onWindows) {
  $null = Step 2 "orch" @("worker", "start", "e2e-worker")
  $null = Step 2 "orch" @("review", "watch", "1")
}

} catch {
  Write-Host "[e2e] FAILED: $($_.Exception.Message)"
  $failed = $true
} finally {
  Set-Location $root
  & npm rm -g orch-os | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[e2e] FAILED: npm rm -g orch-os"
    $failed = $true
  }
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
if ($failed) { exit 1 }
Write-Host "[e2e] PASSED: every command returned the wanted exit code"
exit 0
