$ErrorActionPreference = 'Stop'
$workspaceDir = Split-Path -Parent $PSScriptRoot
$sourceDir = Join-Path $workspaceDir 'dy-lead-app'
$releaseDir = Join-Path $workspaceDir 'dy-lead-app-release'
$installerCompilerPath = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 7\ISCC.exe'
$releasePackage = Get-Content -LiteralPath (Join-Path $releaseDir 'resources\app\package.json') -Raw | ConvertFrom-Json
if ($releasePackage.version -ne '2.2.11') { throw '发行目录不是本版' }
foreach ($unchangedFile in @('lib\ai-policy.js','lib\keyword-screen.js','web\app.js','web\index.html','web\style.css')) {
  if ((Get-FileHash -LiteralPath (Join-Path $releaseDir $unchangedFile)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $sourceDir $unchangedFile)).Hash) { throw ('发行文件与最终源码不一致：' + $unchangedFile) }
}
# The initial build already generated and privacy-checked this release. Only
# test fixture compatibility changed after that stage; resume every remaining gate.
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'verify-field-guide.js')
if ($LASTEXITCODE -ne 0) { throw '同期指南验证失败' }
foreach ($checkScript in @('verify.js','verify-collection.js','verify-outreach-browser.js','verify-outreach-flow.js','verify-startup-login.js','verify-ai.js','verify-ui.js','verify-browser-sandbox.js','verify-browser-portability.js','verify-license.js','verify-legacy-preflight.js')) {
  & (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot $checkScript)
  if ($LASTEXITCODE -ne 0) { throw ('发行验收失败：' + $checkScript) }
}
& (Join-Path $PSScriptRoot 'verify-desktop.ps1')
& $installerCompilerPath /Q (Join-Path $PSScriptRoot 'setup.iss')
if ($LASTEXITCODE -ne 0) { throw '安装包编译失败' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archivePath = Join-Path $workspaceDir '华贸获客-程序包-2.2.11.zip'
if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath }
[System.IO.Compression.ZipFile]::CreateFromDirectory($releaseDir, $archivePath)
& (Join-Path $PSScriptRoot 'verify-artifacts.ps1')
Write-Output '2.2.11 所有剩余验收及安装包、程序包完成'
