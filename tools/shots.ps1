# Launch the built Drydock IDE once per theme on the sample workspace and capture each window to PNG.
#   powershell -File tools\shots.ps1 [-App <path\to\Drydock.exe>] [-Workspace <folder>] [-Out <folder>]
# Each theme gets its own temporary user-data-dir, so the captures show first-run defaults.
param(
  [string]$App = "$env:USERPROFILE\dd\harness\VSCode-win32-x64\Drydock.exe",
  [string]$Workspace = "$env:USERPROFILE\Documents\drydock-ide-sample",
  [string]$Out = "$env:USERPROFILE\dd\shots",
  [string[]]$Themes = @("Drydock Dark", "Drydock Glass", "Drydock Paper", "Drydock Aqua")
)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Shot {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
}
"@
New-Item -ItemType Directory -Force $Out | Out-Null
$file = Join-Path $Workspace "ServerScriptService\ShopService.server.luau"
foreach ($theme in $Themes) {
  Get-Process -Name Drydock -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep 2
  $slug = ($theme -replace '[^A-Za-z0-9]+', '-').ToLower()
  $ud = Join-Path $env:TEMP "drydock-shot-$slug"
  if (Test-Path $ud) { Remove-Item -Recurse -Force $ud }
  New-Item -ItemType Directory -Force (Join-Path $ud "User") | Out-Null
  $settings = @{ "workbench.colorTheme" = $theme; "drydock.glass" = ($theme -eq "Drydock Glass"); "workbench.startupEditor" = "none"; "window.restoreWindows" = "none" }
  ($settings | ConvertTo-Json) | Set-Content -Encoding utf8 (Join-Path $ud "User\settings.json")
  Start-Process -FilePath $App -ArgumentList @('--user-data-dir', "`"$ud`"", '--disable-workspace-trust', "`"$Workspace`"", "`"$file`"")
  Start-Sleep 20
  $p = Get-Process -Name Drydock -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $p) { Write-Output "$theme : no window"; continue }
  $h = $p.MainWindowHandle
  [Shot]::MoveWindow($h, 200, 120, 1456, 908, $true) | Out-Null
  [Shot]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003) | Out-Null
  Start-Sleep 3
  $r = New-Object Shot+R; [Shot]::GetWindowRect($h, [ref]$r) | Out-Null
  $bmp = New-Object System.Drawing.Bitmap ($r.Rt - $r.L), ($r.B - $r.T)
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
  $png = Join-Path $Out "$slug.png"; $bmp.Save($png); $g.Dispose(); $bmp.Dispose()
  [Shot]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0003) | Out-Null
  Write-Output "$theme : $png ($($p.MainWindowTitle))"
}
Get-Process -Name Drydock -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
