$ErrorActionPreference = 'Stop'
$workspaceDir = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $workspaceDir 'dy-lead-app-release'
$releaseVersion = (Get-Content -LiteralPath (Join-Path $workspaceDir 'desktop/package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($releaseVersion -notmatch '^\d+\.\d+\.\d+$') { throw '客户端版本格式无效' }
$installerPath = Join-Path $workspaceDir "华贸获客-安装包-$releaseVersion.exe"
$archivePath = Join-Path $workspaceDir "华贸获客-程序包-$releaseVersion.zip"
$releasePackage = Get-Content -LiteralPath (Join-Path $releaseDir 'resources/app/package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($releasePackage.version -ne $releaseVersion) { throw '客户端与产物版本不一致' }
$wsPackage = Get-Content -LiteralPath (Join-Path $releaseDir 'node_modules/ws/package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($wsPackage.name -ne 'ws' -or $wsPackage.version -ne '8.22.0') { throw '内嵌浏览器 ws 依赖不匹配' }
foreach ($relativePath in @('resources/app/main.js', 'resources/app/preload.js', 'resources/app/account-browser-host.js', 'lib/embedded-browser-client.js')) {
  if (!(Test-Path -LiteralPath (Join-Path $releaseDir $relativePath) -PathType Leaf)) { throw "内嵌浏览器缺少发行模块：$relativePath" }
  $sourcePath = if ($relativePath.StartsWith('resources/app/')) { Join-Path $workspaceDir ('desktop/' + $relativePath.Substring('resources/app/'.Length)) } else { Join-Path $workspaceDir ('dy-lead-app/' + $relativePath) }
  if ((Get-FileHash -LiteralPath (Join-Path $releaseDir $relativePath) -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash) { throw "内嵌浏览器发行模块与源码不一致：$relativePath" }
}
$usagePaths = @((Join-Path $workspaceDir 'desktop/使用说明.txt'), (Join-Path $releaseDir '使用说明.txt'), (Join-Path $releaseDir 'resources/app/使用说明.txt'))
$usageHash = $null
foreach ($usagePath in $usagePaths) {
  if (!(Test-Path -LiteralPath $usagePath -PathType Leaf)) { throw '缺少随包使用说明' }
  $usageText = Get-Content -LiteralPath $usagePath -Raw -Encoding UTF8
  if (!$usageText.StartsWith("华贸获客 $releaseVersion 独立客户端") -or !$usageText.Contains("华贸获客-字段与采集流程说明-$releaseVersion.html")) { throw '随包使用说明未对应当前版本' }
  $currentUsageHash = (Get-FileHash -LiteralPath $usagePath -Algorithm SHA256).Hash
  if ($usageHash -and $usageHash -ne $currentUsageHash) { throw '源码及发行目录的使用说明不一致' }
  $usageHash = $currentUsageHash
}
$guideName = "华贸获客-字段与采集流程说明-$releaseVersion.html"
$releaseGuide = Join-Path $releaseDir "使用文档/$guideName"
if (!(Test-Path -LiteralPath $releaseGuide -PathType Leaf)) { throw '发布目录缺少当前字段流程 HTML 文档' }
if (!(Get-Content -LiteralPath $releaseGuide -Raw -Encoding UTF8).Contains("字段与采集流程说明 $releaseVersion</title>")) { throw '发布 HTML 文档版本不匹配' }
if ((Get-FileHash -LiteralPath $releaseGuide -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath (Join-Path $workspaceDir "使用文档/$guideName") -Algorithm SHA256).Hash) { throw '发布 HTML 文档与当前生成文档不一致' }
$publicConfig = Get-Content -LiteralPath (Join-Path $releaseDir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$trustedConfig = Get-Content -LiteralPath (Join-Path $releaseDir 'trusted-license.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($publicConfig.dataDir -ne '' -or !$publicConfig.license.enabled -or $publicConfig.PSObject.Properties.Name -contains 'adminPassword' -or $publicConfig.license.PSObject.Properties.Name -contains 'adminKey') { throw '客户配置含非公开字段' }
if ($trustedConfig.serverUrl.TrimEnd('/') -ne 'https://huamao.xyz/dy-license' -or $trustedConfig.allowedHosts.Count -ne 1 -or $trustedConfig.allowedHosts[0] -ne 'huamao.xyz' -or $trustedConfig.publicKey -match 'PRIVATE KEY') { throw '正式公开授权配置不匹配' }
if (Test-Path -LiteralPath (Join-Path $releaseDir 'LICENSE')) { throw '发布目录中存在可能遮蔽 license.js 的 LICENSE 文件' }
if (!(Test-Path -LiteralPath (Join-Path $releaseDir 'Electron-LICENSE.txt'))) { throw '缺少 Electron 许可证声明' }
if (Test-Path -LiteralPath (Join-Path $releaseDir 'data')) { throw '发布目录含用户 data' }
$releaseFiles = @(Get-ChildItem -LiteralPath $releaseDir -Recurse -File)
$expectedFiles = @{}
foreach ($file in $releaseFiles) {
  $relativeName = $file.FullName.Substring($releaseDir.Length + 1).Replace('\', '/')
  if ($relativeName -match '(^|/)(管理端配置\.env|本人测试账户\.txt|本机管理员密码\.txt|keys\.json|users\.json|license-cache\.json|服务器密钥\.txt|网页管理登录信息\.txt|网页登录账户\.txt|admin\.json|audit(?:\.previous)?\.jsonl|service\.env)(/|$)' -or $relativeName -match '^(tools|license-server|data)(/|$)' -or $relativeName -match '(^|/)(chrome-profiles|electron-profiles|license-admin-web|admin-data)(/|$)') { throw '发布目录出现不应交付的私密或用户数据路径' }
  $expectedFiles[$relativeName] = $file.Length
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  $actualCount = 0
  $seenFiles = @{}
  foreach ($entry in $archive.Entries) {
    $entryName = $entry.FullName.Replace('\', '/')
    if ($entryName.EndsWith('/')) { continue }
    if ($seenFiles.ContainsKey($entryName) -or !$expectedFiles.ContainsKey($entryName) -or $entry.Length -ne $expectedFiles[$entryName]) { throw '绿色 ZIP 清单与最终发布目录不一致' }
    $seenFiles[$entryName] = $true
    $actualCount++
  }
  if ($actualCount -ne $expectedFiles.Count) { throw '绿色 ZIP 缺少发布文件' }
} finally { $archive.Dispose() }
$artifacts = @()
foreach ($artifactPath in @($installerPath, $archivePath)) {
  $artifact = Get-Item -LiteralPath $artifactPath
  if ($artifact.Length -lt 100MB) { throw '产物长度异常，拒绝作为完整发布' }
  $artifacts += [PSCustomObject]@{ name = $artifact.Name; bytes = $artifact.Length; sha256 = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$report = [PSCustomObject]@{ version = $releaseVersion; defaultInstallDirectory = 'D:\华贸自媒体获客'; createdAt = (Get-Date).ToString('o'); releaseFiles = $releaseFiles.Count; archiveManifestMatches = $true; customerSecretsAbsent = $true; embeddedBrowser = 'Electron WebContentsView'; wsVersion = $wsPackage.version; authorizationUrl = $trustedConfig.serverUrl; artifacts = $artifacts }
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'artifact-verification.json') -Encoding UTF8
$checksumText = "抖音获客软件 $releaseVersion 完整产物 SHA256`r`n`r`n" + (($artifacts | ForEach-Object { $_.sha256 + '  ' + $_.name + '  (' + $_.bytes + ' bytes)' }) -join "`r`n") + "`r`n"
$checksumText | Set-Content -LiteralPath (Join-Path $workspaceDir '独立客户端校验值.txt') -Encoding UTF8
Write-Output ('PASS: 绿色 ZIP 与发布目录 ' + $releaseFiles.Count + ' 个文件一致，客户包不含用户数据或管理秘密，安装包和 ZIP 的 SHA256 已保存')
$artifacts | Format-Table -AutoSize

