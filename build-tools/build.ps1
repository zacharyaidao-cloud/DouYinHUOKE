param([string]$InstallerCompilerPath = '', [switch]$FocusedChecks)
$ErrorActionPreference = 'Stop'
$workspaceDir = Split-Path -Parent $PSScriptRoot
$sourceDir = Join-Path $workspaceDir 'dy-lead-app'
$releaseVersion = (Get-Content -LiteralPath (Join-Path $workspaceDir 'desktop/package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($releaseVersion -notmatch '^\d+\.\d+\.\d+$') { throw '客户端版本格式无效' }
if (!$InstallerCompilerPath) { $InstallerCompilerPath = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 7\ISCC.exe' }
if (!(Test-Path -LiteralPath $installerCompilerPath)) { throw '缺少 Inno Setup 7' }
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'generate-field-guide.js')
if ($LASTEXITCODE -ne 0) { throw '同期字段字典与流程文档生成失败' }
if (!$FocusedChecks) {
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'verify-field-guide.js')
if ($LASTEXITCODE -ne 0) { throw '字段字典与流程文档验证失败' }
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'verify-build-preflight.js')
if ($LASTEXITCODE -ne 0) { throw '打包配置失败隔离验证失败' }
}
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'build.js')
if ($LASTEXITCODE -ne 0) { throw '发布程序生成失败' }
# 受限环境修复：Node 复制出的二进制文件可能被系统安全策略标记为受限（启动即崩）。
# 用 PowerShell Copy-Item 重新覆盖 Electron 运行时与内置 Chromium/Node 二进制，文件内容 1:1。
$releaseDir = Join-Path $workspaceDir 'dy-lead-app-release'
$runtimeDir = Join-Path $PSScriptRoot 'electron-runtime-44.6.0'
foreach ($binary in @('chrome_100_percent.pak','chrome_200_percent.pak','d3dcompiler_47.dll','dxcompiler.dll','dxil.dll','ffmpeg.dll','icudtl.dat','resources.pak','snapshot_blob.bin','v8_context_snapshot.bin','vk_swiftshader.dll','vk_swiftshader_icd.json','vulkan-1.dll','version')) {
  Copy-Item -LiteralPath (Join-Path $runtimeDir $binary) -Destination (Join-Path $releaseDir $binary) -Force
}
Copy-Item -LiteralPath (Join-Path $runtimeDir 'electron.exe') -Destination (Join-Path $releaseDir '抖音获客软件.exe') -Force
Copy-Item -LiteralPath (Join-Path $sourceDir 'node.exe') -Destination (Join-Path $releaseDir 'node.exe') -Force
Copy-Item -LiteralPath (Join-Path $sourceDir 'node_modules\playwright-core\.local-browsers') -Destination (Join-Path $releaseDir 'node_modules\playwright-core') -Recurse -Force
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'verify-clean-release.js')
if ($LASTEXITCODE -ne 0) { throw '全新客户默认设置与隐私隔离验证失败' }

# ---------------------------------------------------------------------------
# 发布门禁（分层）。任何一层失败立即停止，不生成安装包。
#   static    版本一致性 / 语法 / 授权配置
#   unit      全部单元与集成测试
#   artifact  产物清单、混淆、隐私、配置、SHA256
#   smoke     真实启动发布版后端并验证健康与拒绝策略
#   deep      真实浏览器与桌面端到端（可选，发布前跑）
#   installer 安装包与绿色包完整性
# ---------------------------------------------------------------------------
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'release-verify.js') '--gates=static,unit,artifact,smoke'
if ($LASTEXITCODE -ne 0) { throw '发布门禁失败：static / unit / artifact / smoke' }
if (!$FocusedChecks) {
  & (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'release-verify.js') '--gates=deep'
  if ($LASTEXITCODE -ne 0) { throw '端到端发布验证失败：deep' }
}
& (Join-Path $PSScriptRoot 'verify-desktop.ps1')
if ($LASTEXITCODE -ne 0) { throw '桌面端启动验证失败' }
& $installerCompilerPath /Q (Join-Path $PSScriptRoot 'setup.iss')
if ($LASTEXITCODE -ne 0) { throw '安装包编译失败' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archivePath = Join-Path $workspaceDir "华贸获客-程序包-$releaseVersion.zip"
if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath }
[System.IO.Compression.ZipFile]::CreateFromDirectory((Join-Path $workspaceDir 'dy-lead-app-release'), $archivePath)
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'release-verify.js') '--gates=installer'
if ($LASTEXITCODE -ne 0) { throw '安装包完整性验证失败' }
& (Join-Path $PSScriptRoot 'verify-artifacts.ps1')
Write-Output '独立客户端安装包和绿色版已生成'
