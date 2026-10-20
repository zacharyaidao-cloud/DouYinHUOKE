$ErrorActionPreference = 'Stop'
$workspaceDir = Split-Path -Parent $PSScriptRoot
$sourceDir = Join-Path $workspaceDir 'dy-lead-app'
$releaseDir = Join-Path $workspaceDir 'dy-lead-app-release'
$installerCompilerPath = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 7\ISCC.exe'
# Continue the verified build after the UI test repair, without rebuilding the
# already-verified shipping engine. Reject stale outreach evidence.
$gate = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'outreach-flow-build-verification.json') -Raw | ConvertFrom-Json -AsHashtable
if (!$gate.ok -or !$gate.actualObfuscatedReleaseEngine -or $gate.version -ne '2.2.10') { throw '缺少最终发行流程验收' }
foreach ($gateFile in @('engine.js','engine-actions.js','scheduler.js','lib/outreach-browser.js','lib/action-receipts.js')) {
  if ((Get-FileHash -LiteralPath (Join-Path $releaseDir $gateFile) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $gate.filesSha256[$gateFile]) { throw '发行源码已变化，需要重新验收' }
}
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'verify-ui.js')
if ($LASTEXITCODE -ne 0) { throw '界面或 EXE 验证失败' }
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'verify-browser-sandbox.js')
if ($LASTEXITCODE -ne 0) { throw '账号浏览器沙箱验证失败' }
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'verify-browser-portability.js')
if ($LASTEXITCODE -ne 0) { throw '客户新电脑浏览器验证失败' }
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'verify-license.js')
if ($LASTEXITCODE -ne 0) { throw '授权租约验证失败' }
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'verify-legacy-preflight.js')
if ($LASTEXITCODE -ne 0) { throw '旧版服务隔离验证失败' }
& (Join-Path $PSScriptRoot 'verify-desktop.ps1')
& $installerCompilerPath /Q (Join-Path $PSScriptRoot 'setup.iss')
if ($LASTEXITCODE -ne 0) { throw '安装包编译失败' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archivePath = Join-Path $workspaceDir '华贸获客-程序包-2.2.10.zip'
if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath }
[System.IO.Compression.ZipFile]::CreateFromDirectory($releaseDir, $archivePath)
& (Join-Path $PSScriptRoot 'verify-artifacts.ps1')
Write-Output '2.2.10 剩余验证、安装包及程序包完成'
