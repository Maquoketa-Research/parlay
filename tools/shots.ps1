# Launch the built Drydock IDE once per theme on the sample workspace and capture each window to PNG.
#   powershell -File tools\shots.ps1 [-App <path\to\Drydock.exe>] [-Workspace <folder>] [-Out <folder>]
# Each theme gets its own temporary user-data-dir, so the captures show first-run defaults. Other Drydock windows
# (yours) are left alone: only the instance this script launches is captured and closed.
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
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  public static string Title(IntPtr h) { var sb = new System.Text.StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  // the largest visible top-level window owned by one of the pids (the main process also owns tiny helper windows)
  public static IntPtr FindBig(int[] pids) {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, (int)pid) < 0 || !IsWindowVisible(h)) return true;
      R r; GetWindowRect(h, out r); long area = (long)(r.Rt - r.L) * (r.B - r.T);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
"@
New-Item -ItemType Directory -Force $Out | Out-Null
$file = Join-Path $Workspace "ServerScriptService\ShopService.server.luau"
foreach ($theme in $Themes) {
  $slug = ($theme -replace '[^A-Za-z0-9]+', '-').ToLower()
  $ud = Join-Path $env:TEMP "drydock-shot-$slug"
  if (Test-Path $ud) { Remove-Item -Recurse -Force $ud }
  New-Item -ItemType Directory -Force (Join-Path $ud "User") | Out-Null
  $settings = @{ "workbench.colorTheme" = $theme; "drydock.glass" = ($theme -eq "Drydock Glass"); "window.systemColorTheme" = "auto"; "workbench.startupEditor" = "none"; "window.restoreWindows" = "none" }
  ($settings | ConvertTo-Json) | Set-Content -Encoding utf8 (Join-Path $ud "User\settings.json")
  $launched = Start-Process -PassThru -FilePath $App -ArgumentList @('--user-data-dir', "`"$ud`"", '--disable-workspace-trust', "`"$Workspace`"", "`"$file`"")
  # The window shows at once with the folder name as its title; the workbench is up when the title carries the
  # file too. Moving the window before that minimizes it, and a fresh profile can take a while (first-run work).
  # The main process also owns tiny helper windows, hence the largest one.
  $h = [IntPtr]::Zero
  foreach ($i in 1..90) {
    Start-Sleep 1
    $pids = @($launched.Id) + @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($launched.Id)" | ForEach-Object ProcessId)
    $h = [Shot]::FindBig([int[]]$pids)
    if ($h -ne [IntPtr]::Zero -and [Shot]::Title($h) -match 'luau') { break }
    $h = [IntPtr]::Zero
  }
  if ($h -eq [IntPtr]::Zero) { Write-Output "$theme : no window"; continue }
  Start-Sleep 6   # views, notifications and the extension's first-run settle
  $p = Get-Process -Id $launched.Id
  # captured where it opened (the new window is on top); something minimizes it now and then, so restore first
  $r = New-Object Shot+R
  foreach ($try in 1..5) {
    [Shot]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
    Start-Sleep 2
    [Shot]::GetWindowRect($h, [ref]$r) | Out-Null
    if ($r.L -gt -30000) { break }
  }
  $bmp = New-Object System.Drawing.Bitmap ($r.Rt - $r.L), ($r.B - $r.T)
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
  $png = Join-Path $Out "$slug.png"; $bmp.Save($png); $g.Dispose(); $bmp.Dispose()
  Write-Output "$theme : $png ($($p.MainWindowTitle))"
  & taskkill /PID $launched.Id /T /F | Out-Null; Start-Sleep 1
}
