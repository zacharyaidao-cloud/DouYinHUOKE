$ErrorActionPreference = 'Stop'
$workspaceDir = Split-Path -Parent $PSScriptRoot
$releaseDir = (Resolve-Path -LiteralPath (Join-Path $workspaceDir 'dy-lead-app-release')).Path.TrimEnd('\')
$installedClientDir = (Resolve-Path -LiteralPath 'D:\华贸自媒体获客').Path.TrimEnd('\')
if ($installedClientDir -ne 'D:\华贸自媒体获客' -or $releaseDir -ne (Join-Path $workspaceDir 'dy-lead-app-release')) { throw '更新目录不符合预期' }
if (@(Get-ChildItem -LiteralPath $installedClientDir -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count -or ((Get-Item -LiteralPath $installedClientDir).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '安装目录存在链接，停止更新' }
if (@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installedClientDir + '\', [StringComparison]::OrdinalIgnoreCase) }).Count) { throw '客户端正在运行，暂缓升级' }
$baseline = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'installed-upgrade-fingerprints-v221.json') -Raw | ConvertFrom-Json -AsHashtable
foreach ($entry in $baseline.files.GetEnumerator()) {
    if ((Get-FileHash -LiteralPath (Join-Path $installedClientDir $entry.Key) -Algorithm SHA256).Hash -ne $entry.Value) { throw '配置或数据变化，停止更新' }
}
$artifactVerification = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'artifact-verification.json') -Raw | ConvertFrom-Json
if ($artifactVerification.version -ne '2.2.1' -or -not $artifactVerification.archiveManifestMatches -or -not $artifactVerification.customerSecretsAbsent) { throw '2.2.1 发布包尚未完成验收' }
$releaseItems = @(Get-ChildItem -LiteralPath $releaseDir -Recurse -Force)
if (@($releaseItems | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw '发布目录存在链接，停止更新' }
$sourceFiles = @($releaseItems | Where-Object { -not $_.PSIsContainer })
$changedCount = 0
$preservedCount = 0
foreach ($sourceFile in $sourceFiles) {
    $relativeName = [IO.Path]::GetRelativePath($releaseDir, $sourceFile.FullName)
    if ($relativeName -eq 'config.json' -or $relativeName.StartsWith('data\', [StringComparison]::OrdinalIgnoreCase) -or $relativeName -match '^unins') { continue }
    $destinationFile = [IO.Path]::GetFullPath((Join-Path $installedClientDir $relativeName))
    if (-not $destinationFile.StartsWith($installedClientDir + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '文件目标超出安装目录' }
    $sourceHash = (Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash
    if ((Test-Path -LiteralPath $destinationFile) -and (Get-FileHash -LiteralPath $destinationFile -Algorithm SHA256).Hash -eq $sourceHash) { $preservedCount++; continue }
    New-Item -ItemType Directory -Path (Split-Path -Parent $destinationFile) -Force | Out-Null
    Copy-Item -LiteralPath $sourceFile.FullName -Destination $destinationFile -Force
    if ((Get-FileHash -LiteralPath $destinationFile -Algorithm SHA256).Hash -ne $sourceHash) { throw '更新后文件哈希不一致' }
    $changedCount++
}
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{D8F1A2B3-5C4E-4F6A-9B7D-2E3A5C7F1E9D}_is1'
$registrationRestored = $false
if (Test-Path -LiteralPath $uninstallKey) {
    $uninstallEntry = Get-ItemProperty -LiteralPath $uninstallKey
    if ([IO.Path]::GetFullPath([string]$uninstallEntry.InstallLocation).TrimEnd('\') -ne $installedClientDir) { throw '卸载登记目录不一致，保留原注册信息' }
} else {
    # Inno 在本机运行库替换失败后的回滚移除了旧卸载登记，保留的卸载程序仍有效。
    foreach ($name in @('unins000.exe','unins000.dat')) { if (-not (Test-Path -LiteralPath (Join-Path $installedClientDir $name))) { throw '缺少原卸载程序，停止登记修复' } }
    New-Item -Path $uninstallKey -Force | Out-Null
    $registrationValues = [ordered]@{
        DisplayName='抖音获客软件'; Publisher='Huamao'; InstallLocation=$installedClientDir;
        DisplayIcon=(Join-Path $installedClientDir 'icon.ico');
        UninstallString=('"' + (Join-Path $installedClientDir 'unins000.exe') + '"');
        QuietUninstallString=('"' + (Join-Path $installedClientDir 'unins000.exe') + '" /SILENT');
        'Inno Setup: App Path'=$installedClientDir;
        'Inno Setup: Icon Group'='抖音获客软件';
        'Inno Setup: User'=[Environment]::UserName
    }
    foreach ($entry in $registrationValues.GetEnumerator()) { New-ItemProperty -LiteralPath $uninstallKey -Name $entry.Key -Value $entry.Value -PropertyType String -Force | Out-Null }
    foreach ($name in @('NoModify','NoRepair')) { New-ItemProperty -LiteralPath $uninstallKey -Name $name -Value 1 -PropertyType DWord -Force | Out-Null }
    $registrationRestored = $true
}
Set-ItemProperty -LiteralPath $uninstallKey -Name DisplayVersion -Value '2.2.1'
$shortcutShell = New-Object -ComObject WScript.Shell
$programGroup = Join-Path ([Environment]::GetFolderPath('Programs')) '抖音获客软件'
New-Item -ItemType Directory -Path $programGroup -Force | Out-Null
foreach ($shortcutPath in @((Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) '抖音获客软件.lnk'), (Join-Path $programGroup '抖音获客软件.lnk'))) {
    $shortcut = $shortcutShell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = Join-Path $installedClientDir '抖音获客软件.exe'
    $shortcut.WorkingDirectory = $installedClientDir
    $shortcut.IconLocation = Join-Path $installedClientDir 'icon.ico'
    $shortcut.Save()
}
$uninstallShortcut = $shortcutShell.CreateShortcut((Join-Path $programGroup '卸载 抖音获客软件.lnk'))
$uninstallShortcut.TargetPath = Join-Path $installedClientDir 'unins000.exe'
$uninstallShortcut.WorkingDirectory = $installedClientDir
$uninstallShortcut.Save()
& (Join-Path $PSScriptRoot 'verify-installed-upgrade-v221.ps1') -Phase after
$updateReport = [ordered]@{ok=$true; version='2.2.1'; method='verified public release file update'; changedFiles=$changedCount; identicalFilesPreserved=$preservedCount; configAndDataPreserved=$true; runtimeSecuritySettingsChanged=$false; uninstallVersion='2.2.1'; uninstallRegistrationRestored=$registrationRestored; shortcutsVerified=$true; previousSilentInstallerIssue='runtime rename access denied'}
$updateReport | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'installed-file-update-v221.json') -Encoding utf8
$updateReport | ConvertTo-Json

