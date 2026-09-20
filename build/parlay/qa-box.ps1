# Turn a Windows PC into the Parlay QA box: the machine the Studio automation and play agents run on. This script
# installs the tools, clones the repo, installs Parlay and configures a GitHub Actions self-hosted runner.
# Remote access (Tailscale + OpenSSH) and starting the runner at logon are deliberately left to you: see
# build/parlay/README.md "QA box" for those steps, they are three commands.
#
#   Run in an elevated PowerShell on the QA box:
#     Set-ExecutionPolicy -Scope Process Bypass -Force
#     irm https://raw.githubusercontent.com/Maquoketa-Research/parlay/main/build/parlay/qa-box.ps1 -OutFile qa-box.ps1
#     .\qa-box.ps1
#
# Idempotent: every step checks before it acts. Things it cannot do for you are printed at the end.
param(
  [string]$Repo = "Maquoketa-Research/parlay",
  [string]$Root = "$env:USERPROFILE\parlay-qa",
  [string]$RunnerLabels = "self-hosted,windows,qa,studio",
  [switch]$NoRunner
)
$ErrorActionPreference = "Stop"
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
$todo = @()

Step "tools (winget)"
$pkgs = @(
  @{ id = "Git.Git";              test = { Have git } },
  @{ id = "GitHub.cli";           test = { Have gh } },
  @{ id = "Tailscale.Tailscale";  test = { Test-Path "C:\Program Files\Tailscale\tailscale.exe" } },
  @{ id = "OpenJS.NodeJS.LTS";    test = { Have node } },
  @{ id = "Roblox.RobloxStudio";  test = { Test-Path "$env:LOCALAPPDATA\Roblox\Versions" } }
)
foreach ($p in $pkgs) {
  if (& $p.test) { "  $($p.id): present"; continue }
  "  installing $($p.id)"
  winget install --id $p.id --exact --silent --accept-source-agreements --accept-package-agreements | Out-Null
}
if (-not (Test-Path "$env:USERPROFILE\.local\bin\claude.exe") -and -not (Have claude)) {
  "  installing Claude Code"
  irm https://claude.ai/install.ps1 | iex
}

Step "power: never sleep, never turn the display off (Studio plays on the desktop)"
powercfg /change standby-timeout-ac 0; powercfg /change monitor-timeout-ac 0; powercfg /change hibernate-timeout-ac 0

Step "repo at $Root"
New-Item -ItemType Directory -Force -Path $Root | Out-Null
if (-not (Test-Path "$Root\parlay\.git")) { git clone --depth 1 "https://github.com/$Repo.git" "$Root\parlay" } else { git -C "$Root\parlay" pull --ff-only }

Step "Parlay (latest release, user setup)"
if (-not (Test-Path "$env:LOCALAPPDATA\Programs\Parlay\Parlay.exe")) {
  if (Have gh) {
    $asset = gh release view --repo $Repo --json assets --jq '.assets[] | select(.name | endswith(".exe")) | .name' | Select-Object -First 1
    if ($asset) {
      gh release download --repo $Repo --pattern $asset --dir $env:TEMP --clobber
      Start-Process -Wait -FilePath "$env:TEMP\$asset" -ArgumentList '/VERYSILENT','/NORESTART','/SUPPRESSMSGBOXES','/MERGETASKS=!runcode'
    } else { $todo += "install Parlay from https://github.com/$Repo/releases" }
  } else { $todo += "install Parlay from https://github.com/$Repo/releases" }
} else { "  present" }

if (-not $NoRunner) {
  Step "GitHub Actions self-hosted runner (labels: $RunnerLabels)"
  $rdir = "$Root\runner"
  if (-not (Test-Path "$rdir\config.cmd")) {
    New-Item -ItemType Directory -Force -Path $rdir | Out-Null
    $rel = Invoke-RestMethod "https://api.github.com/repos/actions/runner/releases/latest"
    $zip = ($rel.assets | Where-Object { $_.name -like "actions-runner-win-x64-*.zip" } | Select-Object -First 1)
    Invoke-WebRequest $zip.browser_download_url -OutFile "$env:TEMP\runner.zip"
    Expand-Archive "$env:TEMP\runner.zip" -DestinationPath $rdir -Force
  }
  if (-not (Test-Path "$rdir\.runner")) {
    $ok = $false
    if (Have gh) { try { $tok = gh api -X POST "repos/$Repo/actions/runners/registration-token" --jq .token; $ok = [bool]$tok } catch {} }
    if ($ok) {
      & "$rdir\config.cmd" --unattended --url "https://github.com/$Repo" --token $tok --name "$env:COMPUTERNAME-qa" --labels $RunnerLabels --work "_work" --replace
      "  runner registered; start it with $rdir\run.cmd (README: how to start it at logon, NOT as a service: Studio needs a desktop)"
      $todo += "start the runner: $rdir\run.cmd, and set it to start at logon (README, QA box)"
    } else { $todo += "gh auth login (an account with admin on $Repo), then re-run this script to register the runner" }
  } else { "  runner already configured" }
}

Step "what only you can do"
$todo += "remote access: README 'QA box' has the three commands (Tailscale up, OpenSSH server, the driver's key)"
$todo += "open Roblox Studio once and sign in with the QA account; leave the box logged in"
$todo += "open Parlay once and sign in with Roblox, so the gate is down for the agents"
$todo | ForEach-Object { "  - $_" }
Write-Host "`nQA box ready: repo $Root\parlay, runner labels $RunnerLabels" -ForegroundColor Green
