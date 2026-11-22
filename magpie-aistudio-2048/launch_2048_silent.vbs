' launch_2048_silent.vbs -- start magpie-aistudio-2048 with ZERO window.
'
' Windows 11 sends newly created consoles to Windows Terminal when started from
' a console host. Launching powershell.exe via GUI-subsystem wscript.exe with
' SW_HIDE (0) keeps conhost hidden from the very start.

Option Explicit

Dim shell, fso, scriptDir, mgr, ps, cmd, q

Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")
q = Chr(34)

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
mgr = fso.BuildPath(scriptDir, "manage_aistudio.ps1")

If Not fso.FileExists(mgr) Then
  WScript.Quit 1
End If

ps = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
cmd = q & ps & q & " -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & q & mgr & q & " start"

shell.Run cmd, 0, False
