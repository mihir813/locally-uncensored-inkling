# Takes the installers `tauri build` wrote, installs the NSIS one silently into
# a clean folder, checks what landed there, starts the app once, makes the
# portable ZIP from that installed folder and runs the uninstaller.
# Writes everything a release needs into -OutDir.
param(
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$BundleDir = 'src-tauri\target\release\bundle'
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $OutDir | Out-Null
$log = Join-Path $OutDir 'windows-install-test.md'
$failed = $false
function Step([string]$name, [bool]$ok, [string]$note = '') {
  $r = if ($ok) { 'PASS' } else { 'FAIL' }
  if (-not $ok) { $script:failed = $true }
  Add-Content $log "| $name | $r | $($note -replace '\|','/') |"
  Write-Host "[$r] $name - $note"
}

$setup = Get-ChildItem (Join-Path $BundleDir 'nsis') -Filter '*-setup.exe' | Select-Object -First 1
$msi = Get-ChildItem (Join-Path $BundleDir 'msi') -Filter '*.msi' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $setup) { throw "no NSIS installer under $BundleDir\nsis" }
$version = (Get-Content 'src-tauri\tauri.conf.json' -Raw | ConvertFrom-Json).version
$llamaTag = (Select-String -Path 'scripts\build-llama.sh' -Pattern '^LLAMA_TAG="\$\{LLAMA_TAG:-(b\d+)\}"').Matches[0].Groups[1].Value
$llamaCommit = (Select-String -Path 'scripts\build-llama.sh' -Pattern '^LLAMA_COMMIT="\$\{LLAMA_COMMIT:-([0-9a-f]{40})\}"').Matches[0].Groups[1].Value
$os = Get-CimInstance Win32_OperatingSystem

Set-Content $log "# Windows install test`n"
Add-Content $log "- Where: GitHub Actions windows-latest runner ($($os.Caption) $($os.Version))"
Add-Content $log "- Installer: $($setup.Name), $($setup.Length) bytes"
Add-Content $log "- App version $version, llama.cpp $llamaTag`n"
Add-Content $log "| Step | Result | Detail |`n|---|---|---|"

Copy-Item $setup.FullName $OutDir
if ($msi) { Copy-Item $msi.FullName $OutDir }

# --- silent install on a machine that never had the app ----------------------
$p = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait -PassThru
$InstallDir = ''
try { $InstallDir = (& "$PSScriptRoot\find-install.ps1" | Select-Object -Last 1) } catch { Write-Host $_ }
Step 'Silent install (NSIS /S)' ($p.ExitCode -eq 0 -and $InstallDir -ne '') "exit code $($p.ExitCode), folder $InstallDir"
if (-not $InstallDir) {
  Add-Content $log "`nOverall: **FAIL**"
  Get-Content $log | Add-Content $env:GITHUB_STEP_SUMMARY
  exit 1
}

$exe = Get-ChildItem $InstallDir -Filter '*.exe' | Where-Object { $_.Name -notmatch '^(lu-llama|uninstall)' } | Select-Object -First 1
Step 'Main program installed' ($null -ne $exe) "$($exe.Name)"
foreach ($f in 'lu-llama-server.exe', 'lu-llama-cvector-generator.exe', 'uninstall.exe') {
  Step "$f installed" (Test-Path (Join-Path $InstallDir $f)) ''
}
$dlls = @(Get-ChildItem $InstallDir -Filter '*.dll')
$cpu = @($dlls | Where-Object { $_.Name -like 'ggml-cpu-*.dll' })
Step 'Engine libraries next to the engine' ($cpu.Count -gt 0 -and ($dlls.Name -contains 'llama.dll')) "$($dlls.Count) DLLs, $($cpu.Count) CPU variants: $(($cpu.Name | Sort-Object) -join ', ')"
Step 'Vulkan backend installed' ($dlls.Name -contains 'ggml-vulkan.dll') ''
$ggufInside = @(Get-ChildItem $InstallDir -Recurse -Filter '*.gguf')
Step 'No model weights in the installation' ($ggufInside.Count -eq 0) "$($ggufInside.Count) .gguf files"

# --- the installed engine runs with nothing else on the machine --------------
$server = Join-Path $InstallDir 'lu-llama-server.exe'
Push-Location $InstallDir
$ver = (& $server --version 2>&1 | Out-String).Trim()
$verExit = $LASTEXITCODE
$dev = (& $server --list-devices 2>&1 | Out-String).Trim()
$devExit = $LASTEXITCODE
Pop-Location
# The build number is a commit count, 1 on the depth-1 checkout. The commit identifies the engine.
Step 'Installed engine starts and is the pinned commit (--version)' ($verExit -eq 0 -and $ver -match $llamaCommit.Substring(0, 7)) (($ver -split "`n")[0])
Step 'Installed engine lists its devices' ($devExit -eq 0) (($dev -split "`n" | Select-Object -Last 3) -join ' ; ')
Set-Content (Join-Path $OutDir 'installed-engine-version.txt') "$ver`n`n$dev"

# What the engine imports that is neither in the folder nor part of Windows.
$deps = & dumpbin /dependents $server 2>$null | Where-Object { $_ -match '^\s+\S+\.dll\s*$' } | ForEach-Object { $_.Trim() }
$missing = @($deps | Where-Object { -not (Test-Path (Join-Path $InstallDir $_)) -and -not (Test-Path (Join-Path $env:WINDIR "System32\$_")) -and $_ -notmatch '^(api-ms-|ext-ms-)' })
Step 'Engine imports resolve from the folder or Windows' ($missing.Count -eq 0) "imports: $($deps -join ', '); unresolved: $($missing -join ', ')"

# --- first start of the app --------------------------------------------------
$app = Start-Process -FilePath $exe.FullName -WorkingDirectory $InstallDir -PassThru
Start-Sleep -Seconds 25
$alive = -not $app.HasExited
$title = ''
if ($alive) { $app.Refresh(); $title = $app.MainWindowTitle }
Step 'App starts and stays up for 25 s' $alive "window title '$title'"
if ($alive) { & taskkill /F /T /PID $app.Id | Out-Null }
Start-Sleep -Seconds 3
$left = @(Get-Process -Name 'lu-llama-server' -ErrorAction SilentlyContinue).Count
Step 'No engine process left after the app closes' ($left -eq 0) "$left process(es)"

# --- portable ZIP: the installed folder without the uninstaller --------------
$portableName = "Locally-Uncensored-$version-inkling-$llamaTag-x64-portable"
$stage = Join-Path $env:RUNNER_TEMP $portableName
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
Copy-Item -Recurse $InstallDir $stage
Remove-Item -Force (Join-Path $stage 'uninstall.exe') -ErrorAction SilentlyContinue
Copy-Item 'inkling\PORTABLE-README.txt' (Join-Path $stage 'PORTABLE-README.txt')
$zip = Join-Path $OutDir "$portableName.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal
Step 'Portable ZIP written' (Test-Path $zip) "$portableName.zip, $((Get-Item $zip).Length) bytes"

# The ZIP is checked the way a user gets it: unpacked somewhere else.
$unzip = 'C:\LU-Portable-Check'
if (Test-Path $unzip) { Remove-Item -Recurse -Force $unzip }
Expand-Archive -Path $zip -DestinationPath $unzip
$pdir = Join-Path $unzip $portableName
Push-Location $pdir
$pver = (& (Join-Path $pdir 'lu-llama-server.exe') --version 2>&1 | Out-String).Trim()
$pverExit = $LASTEXITCODE
Pop-Location
Step 'Portable engine starts from the unpacked ZIP' ($pverExit -eq 0) (($pver -split "`n")[0])
$papp = Start-Process -FilePath (Join-Path $pdir $exe.Name) -WorkingDirectory $pdir -PassThru
Start-Sleep -Seconds 20
$palive = -not $papp.HasExited
Step 'Portable app starts and stays up for 20 s' $palive ''
if ($palive) { & taskkill /F /T /PID $papp.Id | Out-Null }
Start-Sleep -Seconds 2

# --- dependency manifest ------------------------------------------------------
$manifest = Join-Path $OutDir 'windows-files-manifest.txt'
"Files the installer puts into the installation folder (app $version, llama.cpp $llamaTag)`n" | Set-Content $manifest
Get-ChildItem $InstallDir -Recurse -File | Sort-Object FullName | ForEach-Object {
  '{0}  {1,12}  {2}' -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower(), $_.Length, $_.FullName.Substring($InstallDir.Length + 1)
} | Add-Content $manifest

# --- uninstall ----------------------------------------------------------------
$u = Start-Process -FilePath (Join-Path $InstallDir 'uninstall.exe') -ArgumentList '/S' -Wait -PassThru
Start-Sleep -Seconds 8
$leftFiles = if (Test-Path $InstallDir) { @(Get-ChildItem $InstallDir -Recurse -File).Count } else { 0 }
$stillListed = $true
try { & "$PSScriptRoot\find-install.ps1" | Out-Null } catch { $stillListed = $false }
Step 'Silent uninstall removes the uninstall entry' (-not $stillListed) ''
Step 'Silent uninstall removes the program' ($u.ExitCode -eq 0 -and -not (Test-Path (Join-Path $InstallDir $exe.Name)) -and -not (Test-Path $server)) "exit code $($u.ExitCode), $leftFiles file(s) left in the folder"

Add-Content $log "`nOverall: **$(if ($failed) { 'FAIL' } else { 'PASS' })**"
Get-Content $log | Add-Content $env:GITHUB_STEP_SUMMARY
if ($failed) { exit 1 }
