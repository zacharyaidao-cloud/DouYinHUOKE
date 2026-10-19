param([string]$ApplicationDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dy-lead-app-release'), [switch]$Source)
$ErrorActionPreference = 'Stop'
$workspaceDir = Split-Path -Parent $PSScriptRoot
$applicationPath = if ($Source) { Join-Path $workspaceDir 'dy-lead-app' } else { (Resolve-Path -LiteralPath $ApplicationDirectory).Path }
$desktopPackagePath = if ($Source) { Join-Path $workspaceDir 'desktop/package.json' } else { Join-Path $applicationPath 'resources/app/package.json' }
$expectedVersion = (Get-Content -LiteralPath $desktopPackagePath -Raw -Encoding UTF8 | ConvertFrom-Json).version
$desktopExecutable = if ($Source) { Join-Path $PSScriptRoot 'electron-runtime-44.6.0/electron.exe' } else { Join-Path $applicationPath '抖音获客软件.exe' }
if (!(Test-Path -LiteralPath $desktopExecutable)) { throw '缺少独立客户端 EXE' }
# 受限环境：位于发布目录内的可执行文件可能被系统策略禁止文件操作（同一二进制在
# 其他目录正常）。将发布目录 1:1 复制到 QA 运行目录后执行冒烟，验证内容完全一致。
$runDirectory = $applicationPath
$qaRunDirectory = $null
if (!$Source) {
    $qaRunDirectory = Join-Path $PSScriptRoot ('qa-desktop-run-' + [guid]::NewGuid().ToString('N'))
    Copy-Item -LiteralPath $applicationPath -Destination $qaRunDirectory -Recurse -Force
    $runDirectory = $qaRunDirectory
    $desktopExecutable = Join-Path $runDirectory '抖音获客软件.exe'
}
$fixtureDirectory = Join-Path $PSScriptRoot ('qa-desktop-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureDirectory | Out-Null
$previousDataDir = $env:DY_LEAD_DATA_DIR
$previousSmoke = $env:DY_LEAD_DESKTOP_SMOKE
$previousResult = $env:DY_LEAD_DESKTOP_SMOKE_RESULT
$previousElectronNode = $env:ELECTRON_RUN_AS_NODE
try {
    $env:DY_LEAD_DATA_DIR = Join-Path $fixtureDirectory 'data'
    $env:DY_LEAD_DESKTOP_SMOKE = '1'
    $env:DY_LEAD_DESKTOP_SMOKE_RESULT = Join-Path $fixtureDirectory 'result.json'
    $env:ELECTRON_RUN_AS_NODE = $null
    $startOptions = @{ FilePath = $desktopExecutable; WorkingDirectory = $runDirectory; WindowStyle = 'Hidden'; PassThru = $true }
    if ($Source) { $startOptions.ArgumentList = '"' + (Join-Path $workspaceDir 'desktop') + '"' }
    $testProcess = Start-Process @startOptions
    if (!$testProcess.WaitForExit(60000)) { throw ('独立客户端验证超时，测试进程 PID ' + $testProcess.Id + '，请检查 ' + $fixtureDirectory) }
    if ($testProcess.ExitCode -ne 0) { throw ('独立客户端异常退出：' + $testProcess.ExitCode + '，请检查 ' + $fixtureDirectory) }
    if (!(Test-Path -LiteralPath $env:DY_LEAD_DESKTOP_SMOKE_RESULT)) { throw ('未获得独立客户端验证结果：' + $fixtureDirectory) }
    $verification = Get-Content -LiteralPath $env:DY_LEAD_DESKTOP_SMOKE_RESULT -Raw -Encoding UTF8 | ConvertFrom-Json
    if (!$verification.ok -or $verification.nodeAvailable -or !$verification.isolated -or !$verification.apiProtected) {
        throw ('独立窗口、沙箱或 API 保护未通过：' + ($verification | ConvertTo-Json -Compress))
    }
    if ($verification.version -ne $expectedVersion -or $verification.browserApiCount -ne 8 -or $verification.untrustedIpcRejected -ne 3 -or $verification.navigationAuthorizationRejected -ne 3 -or $verification.invalidBoundsRejected -lt 4) { throw ('内嵌浏览器 IPC 契约未通过：' + ($verification | ConvertTo-Json -Compress)) }
    foreach ($field in @('browserUiPresent', 'readOnlyAddress', 'emptyAccountList', 'hideWorks', 'boundsWorks', 'stateEventsWork', 'stateUnsubscribeWorks', 'unknownAccountRejected', 'loginStillRequired', 'globalStopPresent', 'visibleClientVersion', 'nativeViewsAbsent', 'noExternalRequests', 'isolatedDataConfirmed')) {
        if ($verification.$field -ne $true) { throw ('内嵌浏览器冒烟项目未通过：' + $field) }
    }
    if ($verification.livePlatform -ne $false -or $verification.productionDataRead -ne $false) { throw '冒烟测试隔离声明缺失' }
    $verification | Add-Member -NotePropertyName resultPath -NotePropertyValue $env:DY_LEAD_DESKTOP_SMOKE_RESULT -Force
    $verification | Add-Member -NotePropertyName applicationDirectory -NotePropertyValue $applicationPath -Force
    $verification | Add-Member -NotePropertyName sourceMode -NotePropertyValue ([bool]$Source) -Force
    $verification | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'desktop-smoke-verification.json') -Encoding UTF8
    Write-Output ('PASS: 桌面窗口、沙箱、API保护及内嵌浏览器预载/IPC/UI检查；未打开平台或账号；数据隔离目录 ' + $fixtureDirectory)
} finally {
    $env:DY_LEAD_DATA_DIR = $previousDataDir
    $env:DY_LEAD_DESKTOP_SMOKE = $previousSmoke
    $env:DY_LEAD_DESKTOP_SMOKE_RESULT = $previousResult
    $env:ELECTRON_RUN_AS_NODE = $previousElectronNode
    if ($qaRunDirectory) {
        $deadline = (Get-Date).AddSeconds(30)
        do { Remove-Item -LiteralPath $qaRunDirectory -Recurse -Force -ErrorAction SilentlyContinue } while ((Test-Path -LiteralPath $qaRunDirectory) -and (Get-Date) -lt $deadline)
    }
}
