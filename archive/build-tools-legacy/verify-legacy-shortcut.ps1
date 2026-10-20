$ErrorActionPreference = 'Stop'
$shortcutPath = 'C:\Users\Public\Desktop\抖音获客软件.lnk'
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
if ($shortcut.TargetPath -ne 'C:\Windows\System32\wscript.exe' -or $shortcut.Arguments -ne '"D:\华贸自媒体获客\启动软件.vbs"') { throw '公共快捷方式目标与本次审阅对象不同' }
$fixtureDirectory = Join-Path $PSScriptRoot ('qa-desktop-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureDirectory | Out-Null
$previousDataDir = $env:DY_LEAD_DATA_DIR
$previousSmoke = $env:DY_LEAD_DESKTOP_SMOKE
$previousResult = $env:DY_LEAD_DESKTOP_SMOKE_RESULT
try {
    $env:DY_LEAD_DATA_DIR = Join-Path $fixtureDirectory 'data'
    $env:DY_LEAD_DESKTOP_SMOKE = '1'
    $env:DY_LEAD_DESKTOP_SMOKE_RESULT = Join-Path $fixtureDirectory 'result.json'
    $launcherProcess = Start-Process -FilePath $shortcut.TargetPath -ArgumentList $shortcut.Arguments -WorkingDirectory $shortcut.WorkingDirectory -WindowStyle Hidden -PassThru
    if (!$launcherProcess.WaitForExit(10000) -or $launcherProcess.ExitCode -ne 0) { throw '兼容启动脚本失败' }
    $deadline = (Get-Date).AddSeconds(45)
    while (!(Test-Path -LiteralPath $env:DY_LEAD_DESKTOP_SMOKE_RESULT) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
    if (!(Test-Path -LiteralPath $env:DY_LEAD_DESKTOP_SMOKE_RESULT)) { throw '公共桌面入口没有启动新版客户端' }
    $result = Get-Content -LiteralPath $env:DY_LEAD_DESKTOP_SMOKE_RESULT -Raw | ConvertFrom-Json
    if (!$result.ok -or $result.nodeAvailable -or !$result.isolated -or !$result.apiProtected) { throw '公共入口独立客户端验证失败' }
    Write-Output ('PASS: 公共桌面旧入口已兼容启动新版独立 EXE；隔离测试目录 ' + $fixtureDirectory)
} finally {
    $env:DY_LEAD_DATA_DIR = $previousDataDir
    $env:DY_LEAD_DESKTOP_SMOKE = $previousSmoke
    $env:DY_LEAD_DESKTOP_SMOKE_RESULT = $previousResult
}
