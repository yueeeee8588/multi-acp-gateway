; Inno Setup 6 Installer Script
; Supports /D overrides via ISCC.exe command line

#ifndef AppName
  #define AppName "Multi-ACP Gateway"
#endif
#ifndef AppVersion
  #define AppVersion "0.16.3"
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
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  TrayExe: String;
  ResultCode: Integer;
  WaitCount: Integer;
begin
  Result := '';
  TrayExe := ExpandConstant('{app}\gateway-tray.exe');
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
