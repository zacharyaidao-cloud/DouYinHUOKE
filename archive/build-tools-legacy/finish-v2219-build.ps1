param([string]$InstallerCompilerPath = '')
$ErrorActionPreference = 'Stop'
$workspaceDir = Split-Path -Parent $PSScriptRoot
$sourceDir = Join-Path $workspaceDir 'dy-lead-app'
if (!$InstallerCompilerPath) { $InstallerCompilerPath = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 7\ISCC.exe' }
if (!(Test-Path -LiteralPath $installerCompilerPath)) { throw '缺少 Inno Setup 7' }
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'verify-collection.js')
if ($LASTEXITCODE -ne 0) { throw '实际混淆发行程序的采集与浏览器动作验证失败' }
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'verify-outreach-browser.js')
if ($LASTEXITCODE -ne 0) { throw '发行浏览器原生关注私信控件定位验证失败' }
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'verify-outreach-flow.js')
if ($LASTEXITCODE -ne 0) { throw '混淆发行程序的固定名单关注私信整流程验证失败' }
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'verify-startup-login.js')
if ($LASTEXITCODE -ne 0) { throw '混淆发行程序的启动自动登录检查验证失败' }
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'verify-ai.js')
if ($LASTEXITCODE -ne 0) { throw '混淆发行程序的AI批量、回填与日志验证失败' }
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'verify-ui.js')
if ($LASTEXITCODE -ne 0) { throw '界面或 EXE 验证失败' }
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'verify-browser-sandbox.js')
if ($LASTEXITCODE -ne 0) { throw '账号浏览器沙箱验证失败' }
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'verify-browser-portability.js')
if ($LASTEXITCODE -ne 0) { throw '客户新电脑浏览器定位与实际内置启动验证失败' }
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'verify-license.js')
if ($LASTEXITCODE -ne 0) { throw '授权租约验证失败' }
& (Join-Path $sourceDir 'node.exe') (Join-Path $PSScriptRoot 'verify-legacy-preflight.js')
if ($LASTEXITCODE -ne 0) { throw '旧版服务隔离验证失败' }
& (Join-Path $PSScriptRoot 'verify-desktop.ps1')
& $installerCompilerPath /Q (Join-Path $PSScriptRoot 'setup.iss')
if ($LASTEXITCODE -ne 0) { throw '安装包编译失败' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archivePath = Join-Path $workspaceDir '华贸获客-程序包-2.2.19.zip'
if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath }
[System.IO.Compression.ZipFile]::CreateFromDirectory((Join-Path $workspaceDir 'dy-lead-app-release'), $archivePath)
& (Join-Path $PSScriptRoot 'verify-artifacts.ps1')
Write-Output '独立客户端安装包和绿色版已生成'

