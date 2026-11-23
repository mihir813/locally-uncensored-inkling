# Prints the folder the NSIS installer put the app into, read from the
# uninstall entry it wrote. The installer chooses the folder itself (all users
# under Program Files when run elevated, the user profile otherwise) and does
# not take /D in this install mode.
$ErrorActionPreference = 'Stop'
foreach ($root in 'HKLM:', 'HKCU:') {
  foreach ($view in 'Software', 'Software\WOW6432Node') {
    $key = "$root\$view\Microsoft\Windows\CurrentVersion\Uninstall\Locally Uncensored"
    $loc = (Get-ItemProperty -Path $key -Name InstallLocation -ErrorAction SilentlyContinue).InstallLocation
    if ($loc) {
      $loc = $loc.Trim('"')
      if (Test-Path (Join-Path $loc 'lu-llama-server.exe')) { Write-Output $loc; exit 0 }
    }
  }
}
throw 'Locally Uncensored is not installed: no uninstall entry with lu-llama-server.exe in its folder'
