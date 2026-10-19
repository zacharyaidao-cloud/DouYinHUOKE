param([Parameter(Mandatory=$true)][ValidateSet('before','after')][string]$Phase)
$ErrorActionPreference = 'Stop'
$installedClientDir = 'D:\华贸自媒体获客'
$workspaceDir = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $PSScriptRoot 'installed-upgrade-fingerprints-v222.json'
$reportPath = Join-Path $PSScriptRoot 'installed-upgrade-verification-v222.json'
$resolvedInstalledDir = (Resolve-Path -LiteralPath $installedClientDir).Path.TrimEnd('\')
if ($resolvedInstalledDir -ne $installedClientDir) { throw '安装目录不符合预期' }
if ((Get-Item -LiteralPath $resolvedInstalledDir).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '安装目录为链接，停止更新' }
$configPath = Join-Path $resolvedInstalledDir 'config.json'
$clientConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$configuredDataDir = if ($clientConfig.dataDir) { [string]$clientConfig.dataDir } else { 'data' }
$clientDataDir = [IO.Path]::GetFullPath((Join-Path $resolvedInstalledDir $configuredDataDir))
if ($clientDataDir -ne (Join-Path $resolvedInstalledDir 'data')) { throw '数据目录不是预期的安装目录内 data，停止自动升级' }
if ((Test-Path -LiteralPath $clientDataDir) -and ((Get-Item -LiteralPath $clientDataDir).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '数据目录为链接，停止更新' }
function Get-ClientSnapshot {
    $checkedFiles = @((Get-Item -LiteralPath $configPath))
    if (Test-Path -LiteralPath $clientDataDir) {
        $dataItems = @(Get-ChildItem -LiteralPath $clientDataDir -Recurse -Force)
        if (@($dataItems | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw '数据目录存在链接，停止自动升级' }
        $checkedFiles += @($dataItems | Where-Object { -not $_.PSIsContainer })
    }
    $fingerprints = [ordered]@{}
    foreach ($item in ($checkedFiles | Sort-Object FullName)) {
        $relativeName = [IO.Path]::GetRelativePath($resolvedInstalledDir, $item.FullName)
        $fingerprints[$relativeName] = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
    }
    return $fingerprints
}
if ($Phase -eq 'before') {
    if (Test-Path -LiteralPath $manifestPath) { throw '升级基线已存在，禁止覆盖' }
    $activeProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($resolvedInstalledDir + '\', [StringComparison]::OrdinalIgnoreCase) })
    if ($activeProcesses.Count) { throw '客户端仍在运行，停止自动升级' }
    $activeBrowsers = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('chrome.exe','msedge.exe','chromium.exe') -and $_.CommandLine -and $_.CommandLine.Contains($clientDataDir + '\chrome-profiles\') })
    if ($activeBrowsers.Count) { throw '专用账号浏览器仍在运行，停止自动升级' }
    $backupDir = Join-Path $PSScriptRoot ('installed-backup-v222-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $backupDir | Out-Null
    $currentOwnerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $backupAcl = New-Object Security.AccessControl.DirectorySecurity
    $backupAcl.SetAccessRuleProtection($true, $false)
    $backupAcl.SetOwner($currentOwnerSid)
    foreach ($sid in @($currentOwnerSid, (New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'), (New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'))) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $backupAcl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $backupDir -AclObject $backupAcl
    $fingerprints = Get-ClientSnapshot
    Copy-Item -LiteralPath $configPath -Destination (Join-Path $backupDir 'config.json')
    if (Test-Path -LiteralPath $clientDataDir) { Copy-Item -LiteralPath $clientDataDir -Destination (Join-Path $backupDir 'data') -Recurse }
    foreach ($entry in $fingerprints.GetEnumerator()) {
        $backupFile = Join-Path $backupDir $entry.Key
        if ((Get-FileHash -LiteralPath $backupFile -Algorithm SHA256).Hash -ne $entry.Value) { throw '升级备份核对失败' }
    }
    [ordered]@{versionBefore=(Get-Content -LiteralPath (Join-Path $resolvedInstalledDir 'resources\app\package.json') -Raw | ConvertFrom-Json).version; installation=$resolvedInstalledDir; dataDirectory=$clientDataDir; backupDirectory=$backupDir; files=$fingerprints} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    [ordered]@{ok=$true; phase='before'; checkedFiles=$fingerprints.Count; backupVerified=$true; installation=$resolvedInstalledDir} | ConvertTo-Json
} else {
    $baseline = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -AsHashtable
    $current = Get-ClientSnapshot
    if ($current.Count -ne $baseline.files.Count) { throw '升级后数据文件数量发生变化' }
    foreach ($entry in $current.GetEnumerator()) { if ($baseline.files[$entry.Key] -ne $entry.Value) { throw '升级后配置或数据指纹不一致' } }
    $installedVersion = (Get-Content -LiteralPath (Join-Path $resolvedInstalledDir 'resources\app\package.json') -Raw | ConvertFrom-Json).version
    if ($installedVersion -ne '2.2.2') { throw '安装版本不是 2.2.2' }
    $releaseDir = Join-Path $workspaceDir 'dy-lead-app-release'
    foreach ($name in @('web\style.css','web\index.html','web\app.js','resources\app\package.json','resources\app\preload.js','server.js','engine.js','lib\login-state.js','lib\account-login.js','lib\browser-actions.js','lib\collection-browser.js','lib\video-links.js','engine-actions.js','ai.js','lead-query.js','抖音获客软件.exe')) {
        if ((Get-FileHash -LiteralPath (Join-Path $resolvedInstalledDir $name) -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath (Join-Path $releaseDir $name) -Algorithm SHA256).Hash) { throw '实际安装文件与验收发布文件不一致' }
    }
    $report = [ordered]@{ok=$true; phase='after'; versionBefore=$baseline.versionBefore; installedVersion=$installedVersion; checkedFiles=$current.Count; dataPreserved=$true; configPreserved=$true; backupVerified=$true; installedAssetsMatchRelease=$true; installation=$resolvedInstalledDir}
    $report | ConvertTo-Json | Set-Content -LiteralPath $reportPath -Encoding utf8
    $report | ConvertTo-Json
}


