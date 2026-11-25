; Inno Setup 6 Installer Script
; Supports /D overrides via ISCC.exe command line

#ifndef AppName
  #define AppName "Multi-ACP Gateway"
#endif
#ifndef AppVersion
  #define AppVersion "0.16.7"
#endif
#ifndef AppPublisher
  #define AppPublisher "Multi-ACP Gateway"
#endif
#ifndef AppExeName
  #define AppExeName "multi-acp-gateway.exe"
#endif
#ifndef AppDirName
  #define AppDirName "MultiAcpGateway"
#endif
#ifndef AppDataFolder
  #define AppDataFolder "MultiAcpGateway"
#endif
#ifndef AppMutex
  #define AppMutex "Local\MultiAcpGatewayTraySingleton"
#endif
#ifndef OutputBaseFilename
  #define OutputBaseFilename "MultiAcpGateway-v" + AppVersion + "-win64-Setup"
#endif
#ifndef SourceDir
  #define SourceDir "..\dist\windows-bundle"
#endif
#ifndef OutputDir
  #define OutputDir "..\dist"
#endif
#ifndef AppId
  #define AppId "{{7E8A4C2B-9D1F-4A6E-8C3B-5F1A2D4E6B80}"
#endif

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\{#AppDirName}
DefaultGroupName={#AppName}
AllowNoIcons=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=app.ico
UninstallDisplayIcon={app}\app.ico
AppMutex={#AppMutex}
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseFilename}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "autostart"; Description: "Launch {#AppName} tray on Windows startup"; GroupDescription: "Startup:"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "app.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\gateway-tray.exe"; IconFilename: "{app}\app.ico"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\gateway-tray.exe"; IconFilename: "{app}\app.ico"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#AppDirName}"; ValueData: """{app}\gateway-tray.exe"" --minimized"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\gateway-tray.exe"; Description: "{cm:LaunchProgram,{#StringChange(AppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
Filename: "{app}\gateway-tray.exe"; Parameters: "--minimized"; Flags: nowait runhidden skipifnotsilent

[UninstallRun]
Filename: "{app}\gateway-tray.exe"; Parameters: "--stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopGatewayTray"

[Code]
function CheckWebView2RegKey(const RootKey: Integer; const SubKey: String): Boolean;
var
  Version: String;
begin
  Result := False;
  if RegQueryStringValue(RootKey, SubKey, 'pv', Version) then
  begin
    Version := Trim(Version);
    Result := (Version <> '') and (Version <> '0.0.0.0');
  end;
end;

function IsWebView2Installed(): Boolean;
var
  SubKey: String;
  Wow64SubKey: String;
begin
  SubKey := 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  Wow64SubKey := 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  Result :=
    CheckWebView2RegKey(HKLM, SubKey) or
    CheckWebView2RegKey(HKLM, Wow64SubKey) or
    CheckWebView2RegKey(HKLM32, SubKey) or
    CheckWebView2RegKey(HKCU, SubKey) or
    CheckWebView2RegKey(HKCU, Wow64SubKey) or
    CheckWebView2RegKey(HKCU32, SubKey);
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if (not WizardSilent) and (not IsWebView2Installed()) then
  begin
    MsgBox(
      'Microsoft Edge WebView2 Runtime was not detected on this system.' + #13#10 + #13#10 +
      'Installing Microsoft Edge WebView2 Runtime is recommended for the best desktop experience. ' +
      'Without it, the desktop client will automatically fall back to system browser mode.' + #13#10 + #13#10 +
      'Installation will continue normally.',
      mbInformation,
      MB_OK
    );
  end;
end;

procedure StopBundledRuntimes(const AppDir: String);
var
  NormalizedDir: String;
  PsCmd: String;
  ResultCode: Integer;
begin
  if AppDir = '' then
    Exit;
  NormalizedDir := AddBackslash(AppDir);
  StringChangeEx(NormalizedDir, '''', '''''', True);
  PsCmd := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' +
    '$dir = ''' + NormalizedDir + '''; ' +
    'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ' +
    'Where-Object { ($_.Name -eq ''bun.exe'' -or $_.Name -eq ''node.exe'') -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase) } | ' +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"';
  Exec('powershell.exe', PsCmd, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure StopGatewayProcesses(const AppDir: String);
var
  TrayExe: String;
  ResultCode: Integer;
  WaitCount: Integer;
begin
  TrayExe := AddBackslash(AppDir) + 'gateway-tray.exe';
  if FileExists(TrayExe) then
  begin
    Exec(TrayExe, '--stop', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    WaitCount := 0;
    while CheckForMutexes('{#AppMutex}') and (WaitCount < 32) do
    begin
      Sleep(250);
      WaitCount := WaitCount + 1;
    end;
  end;

  Exec('taskkill.exe', '/F /IM gateway-tray.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/F /IM multi-acp-gateway.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/F /IM aistudio2api.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  StopBundledRuntimes(AppDir);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  StopGatewayProcesses(ExpandConstant('{app}'));
end;

function InitializeUninstall(): Boolean;
begin
  Result := True;
  StopGatewayProcesses(ExpandConstant('{app}'));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{localappdata}\{#AppDataFolder}\data');
    if (not UninstallSilent) and DirExists(DataDir) then
    begin
      if MsgBox(
        'Do you want to remove user data and configuration directory?' + #13#10 +
        DataDir + #13#10 +
        '(Choose "No" to keep your data for future reinstallation.)',
        mbConfirmation,
        MB_YESNO or MB_DEFBUTTON2
      ) = IDYES then
      begin
        DelTree(DataDir, True, True, True);
      end;
    end;
  end;
end;
