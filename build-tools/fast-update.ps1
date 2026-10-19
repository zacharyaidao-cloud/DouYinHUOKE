param([switch]$SkipUiTest)
# 快速更新（界面类改动专用）：重建发布目录 + 快速校验 + 同步到安装目录 + 重启客户端。
# 跳过：真实浏览器启动验证、安装包编译、绿色版 zip（这些只对引擎/后端改动有意义）。
$ErrorActionPreference = 'Stop'
$workspaceDir = 'D:\B1-抖音获客'
$sourceDir = Join-Path $workspaceDir 'dy-lead-app'
$releaseDir = Join-Path $workspaceDir 'dy-lead-app-release'
$installed = 'D:\华贸自媒体获客'
$node = Join-Path $sourceDir 'node.exe'

Write-Output '1/6 生成当前版本字段流程文档'
& $node (Join-Path $workspaceDir 'build-tools\generate-field-guide.js')
if ($LASTEXITCODE -ne 0) { throw '字段流程文档生成失败' }

Write-Output '2/6 重建发布目录（混淆+组装）'
& $node (Join-Path $workspaceDir 'build-tools\build.js')
if ($LASTEXITCODE -ne 0) { throw '发布程序生成失败' }

Write-Output '3/6 快速校验默认设置与隐私隔离'
& $node (Join-Path $workspaceDir 'build-tools\verify-clean-release.js')
if ($LASTEXITCODE -ne 0) { throw '发布校验失败' }

Write-Output '4/6 关闭运行中的客户端'
Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq '抖音获客软件.exe') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match '华贸自媒体获客') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 5

Write-Output '5/6 同步到安装目录（保留 config.json / data / unins）'
$releaseFiles = Get-ChildItem $releaseDir -Recurse -File -Force | ForEach-Object { $_.FullName.Substring($releaseDir.Length + 1) }
foreach ($f in (Get-ChildItem $installed -Recurse -File -Force)) {
  $rel = $f.FullName.Substring($installed.Length + 1)
  if ($rel -eq 'config.json' -or $rel.StartsWith('data\') -or $rel -match '^unins') { continue }
  if ($rel -notin $releaseFiles) { Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue }
}
$errors = 0
foreach ($f in (Get-ChildItem $releaseDir -Recurse -File -Force)) {
  $rel = $f.FullName.Substring($releaseDir.Length + 1)
  if ($rel -eq 'config.json' -or $rel.StartsWith('data\') -or $rel -match '^unins') { continue }
  $dest = Join-Path $installed $rel
  if (!(Test-Path (Split-Path $dest -Parent))) { New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force | Out-Null }
  try { Copy-Item $f.FullName $dest -Force -ErrorAction Stop } catch { $errors++; Write-Output ("复制失败: " + $rel) }
}
$diff = 0; $missing = 0; $extra = 0
foreach ($f in (Get-ChildItem $releaseDir -Recurse -File -Force)) {
  $rel = $f.FullName.Substring($releaseDir.Length + 1)
  if ($rel -eq 'config.json' -or $rel.StartsWith('data\') -or $rel -match '^unins') { continue }
  $dest = Join-Path $installed $rel
  if (-not (Test-Path $dest)) { $missing++; continue }
  if ((Get-FileHash $dest -Algorithm SHA256).Hash -ne (Get-FileHash $f.FullName -Algorithm SHA256).Hash) { $diff++ }
}
foreach ($f in (Get-ChildItem $installed -Recurse -File -Force)) {
  $rel = $f.FullName.Substring($installed.Length + 1)
  if ($rel -eq 'config.json' -or $rel.StartsWith('data\') -or $rel -match '^unins') { continue }
  if (-not (Test-Path (Join-Path $releaseDir $rel))) { $extra++ }
}
Write-Output ("同步完成：复制错误 {0} | 不一致 {1} | 缺失 {2} | 多余 {3}" -f $errors, $diff, $missing, $extra)
if ($diff -ne 0 -or $missing -ne 0 -or $extra -ne 0) { throw '同步一致性校验失败' }

Write-Output '6/6 重启客户端'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$p = Start-Process -FilePath (Join-Path $installed '抖音获客软件.exe') -WorkingDirectory $installed -PassThru
Start-Sleep -Seconds 18
$count = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq '抖音获客软件.exe' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match '华贸自媒体获客') }).Count
Write-Output ("客户端进程数: " + $count)
if ($count -lt 2) { throw '客户端启动异常，请检查日志' }
Write-Output '快速更新完成'
