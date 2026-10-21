; 抖音获客软件 安装包脚本（Inno Setup 6.3+ / 7）
; 默认安装到 D:\华贸自媒体获客；用户仍可在安装向导选择其他目录。

#define MyAppName "抖音获客软件"
#define MyAppVersion "2.5.2"
#define MyAppDir "..\dy-lead-app-release"
#define MyAppExeName "抖音获客软件.exe"

[Setup]
AppId={{D8F1A2B3-5C4E-4F6A-9B7D-2E3A5C7F1E9D}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=Huamao
DefaultDirName=D:\华贸自媒体获客
UsePreviousAppDir=yes
DisableDirPage=no
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..
OutputBaseFilename=华贸获客-安装包-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupIconFile=app.ico
UninstallDisplayIcon={app}\icon.ico
UninstallLogMode=overwrite
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
; 简体中文语言文件随项目提供（Inno Setup 官方仓库 jrsoftware/issrc 标签 is-6_7_3 的 Files/Languages/Unofficial），Inno Setup 6 未自带
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Files]
Source: "{#MyAppDir}\*"; DestDir: "{app}"; Excludes: "config.json,data\*"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#MyAppDir}\config.json"; DestDir: "{app}"; Flags: onlyifdoesntexist uninsneveruninstall

[Icons]
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\icon.ico"; WorkingDir: "{app}"
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\icon.ico"; WorkingDir: "{app}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "立即启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent runasoriginaluser

; 用户数据和 config.json 在卸载及升级时保留。

