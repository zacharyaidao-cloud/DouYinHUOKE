$ErrorActionPreference = 'Stop'
$workspaceDir = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$installRoot = 'D:\华贸自媒体获客'
$cleanupTargets = @(
    $installRoot,
    'C:\Users\HUAMAO\AppData\Roaming\Huamao\DouyinLeadDesktop',
    'C:\Users\HUAMAO\AppData\Local\Huamao\DouyinLead',
    'C:\Users\HUAMAO\Desktop\抖音获客软件.lnk',
    'C:\Users\Public\Desktop\抖音获客软件.lnk',
    'C:\Users\HUAMAO\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\抖音获客软件',
    'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\抖音获客软件'
)
$uninstallKeys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{D8F1A2B3-5C4E-4F6A-9B7D-2E3A5C7F1E9D}_is1',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{D8F1A2B3-5C4E-4F6A-9B7D-2E3A5C7F1E9D}_is1',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{D8F1A2B3-5C4E-4F6A-9B7D-2E3A5C7F1E9D}_is1'
)

function Assert-CleanupTarget([string]$target) {
    $absolute = [IO.Path]::GetFullPath($target).TrimEnd('\')
    if ($cleanupTargets -notcontains $absolute) { throw ('清理路径不在已确认范围：' + $absolute) }
    if (Test-Path -LiteralPath $absolute) {
        $resolved = (Resolve-Path -LiteralPath $absolute).ProviderPath.TrimEnd('\')
        if ($resolved -ne $absolute) { throw ('清理路径解析不一致：' + $absolute) }
        $entry = Get-Item -LiteralPath $absolute -Force
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('拒绝递归清理链接路径：' + $absolute) }
        if ($entry.PSIsContainer) {
            $links = @(Get-ChildItem -LiteralPath $absolute -Force -Recurse -Attributes ReparsePoint)
            if ($links.Count) { throw ('清理目录中有链接，需单独核对：' + $absolute) }
        }
    }
}

foreach ($target in $cleanupTargets) { Assert-CleanupTarget $target }
foreach ($newPackage in @('华贸获客-安装包-2.1.0.exe','华贸获客-程序包-2.1.0.zip')) {
    if (!(Test-Path -LiteralPath (Join-Path $workspaceDir $newPackage))) { throw ('缺少需要保留的新包：' + $newPackage) }
}
$configPath = Join-Path $installRoot 'config.json'
if (Test-Path -LiteralPath $configPath) {
    $installedConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (![string]::IsNullOrWhiteSpace([string]$installedConfig.dataDir)) {
        $dataPath = [IO.Path]::GetFullPath((Join-Path $installRoot ([string]$installedConfig.dataDir)))
        if ($dataPath -ne (Join-Path $installRoot 'data')) { throw '安装配置的数据目录已变化，停止清理以核对范围' }
    }
    Remove-Variable installedConfig
}

# 只停止从旧安装目录启动的进程及其子进程，排除本次执行器。
$allProcesses = @(Get-CimInstance Win32_Process)
$processesToStop = @($allProcesses | Where-Object {
    $_.ProcessId -ne $PID -and (
        ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($installRoot + '\',[StringComparison]::OrdinalIgnoreCase)) -or
        ($_.Name -in @('node.exe','wscript.exe','cscript.exe','chrome.exe','msedge.exe','electron.exe') -and $_.CommandLine -and $_.CommandLine.IndexOf($installRoot + '\',[StringComparison]::OrdinalIgnoreCase) -ge 0)
    )
})
$ownedIds = [Collections.Generic.HashSet[uint32]]::new()
foreach ($process in $processesToStop) { [void]$ownedIds.Add([uint32]$process.ProcessId) }
do {
    $added = 0
    foreach ($process in $allProcesses) {
        if ($process.ProcessId -ne $PID -and $ownedIds.Contains([uint32]$process.ParentProcessId) -and $ownedIds.Add([uint32]$process.ProcessId)) {
            $processesToStop += $process
            $added++
        }
    }
} while ($added -gt 0)
foreach ($process in $processesToStop) {
    $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $process.ProcessId) -ErrorAction SilentlyContinue
    if ($current -and $current.CreationDate -eq $process.CreationDate -and $current.Name -eq $process.Name) {
        Stop-Process -Id $current.ProcessId -Force
    }
}
Write-Output ('已停止旧客户端进程：' + $processesToStop.Count)

$uninstaller = Join-Path $installRoot 'unins000.exe'
$uninstallExitCode = $null
if (Test-Path -LiteralPath $uninstaller) {
    $logPath = Join-Path $PSScriptRoot 'old-client-uninstall.log'
    $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/LOG="' + $logPath + '"')) -WorkingDirectory $workspaceDir -WindowStyle Hidden -PassThru
    if (!$uninstallProcess.WaitForExit(60000)) { throw '旧客户端卸载仍在运行，暂不执行数据删除' }
    $uninstallExitCode = $uninstallProcess.ExitCode
    if ($uninstallExitCode -notin @(0,3010)) { throw ('旧客户端卸载失败：' + $uninstallExitCode) }
    Write-Output ('官方卸载程序完成：' + $uninstallExitCode)
}

# 卸载器会保留 config 和 data，按本次明确授权清除这些残留及专属缓存。
$removedTargets = @()
foreach ($target in $cleanupTargets) {
    Assert-CleanupTarget $target
    if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Recurse -Force
        $removedTargets += $target
    }
}
$removedKeys = @()
foreach ($registryPath in $uninstallKeys) {
    if (Test-Path -LiteralPath $registryPath) {
        $entry = Get-ItemProperty -LiteralPath $registryPath
        if ([string]$entry.InstallLocation -and ([string]$entry.InstallLocation).TrimEnd('\') -eq $installRoot -and $entry.DisplayName -match '抖音获客|华贸获客') {
            Remove-Item -LiteralPath $registryPath -Recurse -Force
            $removedKeys += $registryPath
        } else { throw ('卸载注册项不属于已确认的安装：' + $registryPath) }
    }
}
$remainingTargets = @($cleanupTargets | Where-Object { Test-Path -LiteralPath $_ })
$remainingKeys = @($uninstallKeys | Where-Object { Test-Path -LiteralPath $_ })
if ($remainingTargets.Count -or $remainingKeys.Count) { throw '旧客户端仍有残留，清理未完成' }
$report = [PSCustomObject]@{
    ok = $true
    completedAt = (Get-Date).ToString('o')
    uninstallExitCode = $uninstallExitCode
    installation = $installRoot
    clearedTargets = $cleanupTargets
    removedResidualTargets = $removedTargets
    removedStaleRegistryEntries = $removedKeys
    remainingTargets = $remainingTargets
    remainingRegistryEntries = $remainingKeys
    newPackagesPreserved = $true
}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'old-client-cleanup-verification.json') -Encoding UTF8
Write-Output 'PASS: 旧客户端、业务数据、登录缓存、旧快捷方式及卸载记录已清理，新交付包保留'
