# Launch the agy-gemini-8048 supervisor with ZERO console window, detached from this caller.
#
# Two problems have to be solved at once:
#
# 1) No black frame. Windows 11 sends every newly created console to Windows Terminal.
#    Starting powershell.exe from a console-subsystem parent, or straight via WMI, still
#    allocates a console that Windows Terminal adopts and keeps on screen (powershell's
#    own -WindowStyle Hidden is ignored by that handoff). The fix is to let a GUI-subsystem
#    host create the supervisor: launch_8048_silent.vbs runs wscript.exe, which starts
#    powershell with the SW_HIDE show-state, so conhost builds the console hidden from the
#    very start and Windows Terminal is never involved.
#
# 2) Outliving the caller. wscript.exe is started through WMI (Win32_Process.Create), so it
#    is parented by WmiPrvSE.exe, which is outside the caller's Windows Job Object. The
#    supervisor therefore survives the shell / sub-agent that triggered this exiting.
#
# start_8048.bat calls the same VBS through wscript.exe directly (it is user-launched, so it
# has no job object to escape); this script is the programmatic entry point that needs the
# WMI detach. Both end in the identical launch_8048_silent.vbs.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs  = Join-Path $root 'launch_8048_silent.vbs'

if (-not (Test-Path -LiteralPath $vbs)) {
  throw "silent launcher not found: $vbs"
}

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path -LiteralPath $wscript)) {
  $wscript = (Get-Command wscript.exe -ErrorAction Stop).Source
}

# //B = batch mode (no message boxes), //Nologo = suppress the banner.
$cmd = '"{0}" //B //Nologo "{1}"' -f $wscript, $vbs
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }

if ($result.ReturnValue -ne 0) {
  Write-Host ("WMI create of wscript failed, returnValue={0}" -f $result.ReturnValue)
  exit 1
}

# Give wscript a moment to spawn the supervisor, then confirm it actually came up.
Start-Sleep -Milliseconds 1200
$sup = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*supervisor_8048.ps1*' } |
  Select-Object -First 1

if ($sup) {
  Write-Host ("supervisor launched silently, no console window: pid={0} (via wscript pid={1})" -f $sup.ProcessId, $result.ProcessId)
} else {
  Write-Host 'wscript returned, but no supervisor process was detected; check data\8048.supervisor.log'
}
