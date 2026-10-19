$ErrorActionPreference = 'Stop'
$installedClientDir = (Resolve-Path -LiteralPath 'D:\华贸自媒体获客').Path.TrimEnd('\')
if ($installedClientDir -ne 'D:\华贸自媒体获客') { throw '安装目录不符合预期' }
$version = (Get-Content -LiteralPath (Join-Path $installedClientDir 'resources\app\package.json') -Raw | ConvertFrom-Json).version
if ($version -ne '2.2.3') { throw '实际客户端版本不是 2.2.3' }
foreach ($name in @('DY_LEAD_DATA_DIR','DY_LEAD_DESKTOP_SMOKE','DY_LEAD_DESKTOP_SMOKE_RESULT')) {
    if ([Environment]::GetEnvironmentVariable($name, 'Process')) { throw '验证进程仍设置测试环境变量，不能验证正常启动' }
}
$existing = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installedClientDir + '\', [StringComparison]::OrdinalIgnoreCase) })
if ($existing.Count) { throw '客户端已运行，暂缓正常启动验证' }
$startupLog = Join-Path $env:APPDATA 'Huamao\DouyinLeadDesktop\logs\startup.log'
$initialLines = if (Test-Path -LiteralPath $startupLog) { @(Get-Content -LiteralPath $startupLog).Count } else { 0 }
$clientExecutable = Join-Path $installedClientDir '抖音获客软件.exe'
$clientProcess = Start-Process -FilePath $clientExecutable -WorkingDirectory $installedClientDir -WindowStyle Hidden -PassThru
$ready = $null
$deadline = [DateTime]::UtcNow.AddSeconds(45)
while ([DateTime]::UtcNow -lt $deadline) {
    $clientProcess.Refresh()
    if ($clientProcess.HasExited) { throw '正常客户端启动提前退出' }
    if (Test-Path -LiteralPath $startupLog) {
        foreach ($line in (Get-Content -LiteralPath $startupLog | Select-Object -Skip $initialLines)) {
            $jsonStart = $line.IndexOf('{')
            if ($jsonStart -lt 0) { continue }
            try { $message = $line.Substring($jsonStart) | ConvertFrom-Json } catch { continue }
            if ($message.event -eq 'ready' -and $message.app -eq 'dy-lead-app' -and $message.version -eq '2.2.3' -and $message.port -ge 1 -and $message.port -le 65535) { $ready = $message }
        }
    }
    if ($ready) { break }
    Start-Sleep -Milliseconds 300
}
if (-not $ready) { throw '实际客户端后台未就绪' }
$health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + [string]$ready.port + '/health') -TimeoutSec 5
if (-not $health.ok -or $health.app -ne 'dy-lead-app' -or $health.version -ne '2.2.3') { throw '实际客户端公开健康检查失败' }
# 第二次启动走软件自己的 single-instance show/focus 路径。
$activation = Start-Process -FilePath $clientExecutable -WorkingDirectory $installedClientDir -WindowStyle Hidden -PassThru
if (-not $activation.WaitForExit(10000)) { throw '单实例激活未完成' }
$deadline = [DateTime]::UtcNow.AddSeconds(10)
while ([DateTime]::UtcNow -lt $deadline) {
    $clientProcess.Refresh()
    if ($clientProcess.MainWindowHandle -ne 0 -and $clientProcess.MainWindowTitle -eq '抖音获客软件') { break }
    Start-Sleep -Milliseconds 250
}
if ($clientProcess.MainWindowHandle -eq 0 -or $clientProcess.MainWindowTitle -ne '抖音获客软件') { throw '未发现已就绪的独立客户端窗口' }
$ownedBackends = @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $clientProcess.Id -and $_.ExecutablePath -eq (Join-Path $installedClientDir 'node.exe') })
if ($ownedBackends.Count -ne 1) { throw '实际客户端后台数量不符合单实例预期' }
$report = [ordered]@{ok=$true; version='2.2.3'; actualDataDirectoryUsed=$true; standaloneWindowReady=$true; windowTitle=$clientProcess.MainWindowTitle; mainPid=$clientProcess.Id; ownedBackendCount=$ownedBackends.Count; noPlatformTasksInvoked=$true; singleInstanceActivationVerified=$true}
$report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'installed-normal-startup-v223.json') -Encoding utf8
$report | ConvertTo-Json
