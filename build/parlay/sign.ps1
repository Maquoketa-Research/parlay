# Authenticode-sign Parlay's Windows binaries: SHA-256 digest, RFC 3161 timestamp. The credential comes from the
# environment (README "Signing"); with none set it prints one line and exits 0, so unsigned builds keep working.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File build/parlay/sign.ps1 <file or folder>...
#   ...sign.ps1 -Verify <file>...        signtool verify /pa /v instead of signing
#
# A folder means every *.exe, *.dll and *.node under it that does not already carry a valid signature
# (Microsoft's vcruntime140.dll, OpenConsole.exe and PSReadLine keep theirs). Inno Setup calls this with one
# file at a time for the setup exe and the uninstaller: build-win32.sh sets VSCODE_INNO_SIGN_CMD to this
# script, which build/gulpfile.vscode.win32.ts hands to ISCC as the "esrp" SignTool named in build/win32/code.iss.
param([Parameter(ValueFromRemainingArguments)][string[]]$Paths, [switch]$Verify)
$ErrorActionPreference = 'Stop'

$pfx = $env:PARLAY_SIGN_PFX; $thumb = $env:PARLAY_SIGN_THUMBPRINT; $azure = $env:PARLAY_SIGN_AZURE_METADATA
if (-not $Verify -and -not $pfx -and -not $thumb -and -not $azure) {
  Write-Host 'unsigned build (set PARLAY_SIGN_PFX, PARLAY_SIGN_THUMBPRINT or PARLAY_SIGN_AZURE_METADATA to sign)'
  exit 0
}
if (-not $Paths) { throw 'usage: sign.ps1 [-Verify] <file or folder>...' }

$signtool = $env:PARLAY_SIGNTOOL
if (-not $signtool) {
  $signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\10.*\x64\signtool.exe' -ErrorAction SilentlyContinue |
    Sort-Object { [version]$_.Directory.Parent.Name } -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $signtool -or -not (Test-Path $signtool)) { throw 'signtool.exe not found: install the Windows SDK (Windows Kits\10\bin\<version>\x64) or set PARLAY_SIGNTOOL' }

$files = @(foreach ($p in $Paths) {
  if (Test-Path $p -PathType Container) { Get-ChildItem $p -Recurse -File -Include *.exe, *.dll, *.node | ForEach-Object FullName }
  else { (Resolve-Path $p).Path }
})

if ($Verify) { & $signtool verify /pa /v @files; exit $LASTEXITCODE }

$files = @($files | Where-Object { (Get-AuthenticodeSignature $_).Status -ne 'Valid' })
if (-not $files) { Write-Host 'signed: nothing to do, every file already carries a valid signature'; exit 0 }

if ($azure) {
  $dlib = $env:PARLAY_SIGN_AZURE_DLIB
  if (-not $dlib) {
    $dlib = Get-ChildItem "$env:USERPROFILE\.nuget\packages\microsoft.trusted.signing.client\*\bin\x64\Azure.CodeSigning.Dlib.dll" -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $dlib) { throw 'Azure.CodeSigning.Dlib.dll not found: install the Microsoft.Trusted.Signing.Client NuGet package or set PARLAY_SIGN_AZURE_DLIB' }
  $cred = @('/dlib', $dlib, '/dmdf', $azure); $mode = "Azure Trusted Signing ($azure)"; $ts = 'http://timestamp.acs.microsoft.com'
} elseif ($thumb) {
  $cred = @('/sha1', $thumb); $mode = "certificate $thumb from the user's store"; $ts = 'http://timestamp.digicert.com'
} else {
  $cred = @('/f', $pfx); if ($env:PARLAY_SIGN_PASSWORD) { $cred += @('/p', $env:PARLAY_SIGN_PASSWORD) }
  $mode = "pfx $pfx"; $ts = 'http://timestamp.digicert.com'
}
if ($env:PARLAY_SIGN_TIMESTAMP) { $ts = $env:PARLAY_SIGN_TIMESTAMP }

Write-Host "signing $($files.Count) file(s) with $mode, timestamp $ts"
# ponytail: 25 per signtool call keeps the command line well under 32K; one timestamp round trip per batch
for ($i = 0; $i -lt $files.Count; $i += 25) {
  $batch = $files[$i..([math]::Min($i + 24, $files.Count - 1))]
  & $signtool sign /fd sha256 /td sha256 /tr $ts @cred @batch
  if ($LASTEXITCODE) { throw "signtool exited $LASTEXITCODE" }
}
