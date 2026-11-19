' launch_8048_silent.vbs -- start the agy-gemini-8048 supervisor with ZERO window.
'
' Why this file exists
' -------------------
' Windows 11 sends every newly created console to Windows Terminal by default.
' When powershell.exe is started by a console-subsystem parent (a shell) or by
' WMI Win32_Process.Create, the console is still allocated and handed off to
' Windows Terminal, which ignores powershell's own "-WindowStyle Hidden" and
' shows a persistent black frame.
'
' wscript.exe is a GUI-subsystem host: it has no console of its own. When it
' creates the child with the SW_HIDE show-state, conhost builds the console
' hidden from the very start, so no Windows Terminal window is ever created and
' nothing is handed off. This is the only reliable "0 window" path on Win 11.
'
' WshShell.Run(command, intWindowStyle, bWaitOnReturn)
'   intWindowStyle = 0   -> SW_HIDE
'   bWaitOnReturn  = False -> return at once; the supervisor outlives wscript.

Option Explicit

Dim shell, fso, scriptDir, sup, ps, cmd, q

Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")
q = Chr(34)   ' keeps the quoting readable and unambiguous

' Resolve the project root from this script's own location.
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
sup = fso.BuildPath(scriptDir, "supervisor_8048.ps1")

If Not fso.FileExists(sup) Then
  WScript.Quit 1
End If

' Prefer the classic Windows PowerShell 5.1 host the supervisor is tested with.
ps = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"

cmd = q & ps & q & " -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & q & sup & q

' SW_HIDE, detached.
shell.Run cmd, 0, False
