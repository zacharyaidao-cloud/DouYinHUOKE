$ErrorActionPreference = 'Stop'
# Resume after source, obfuscated collection/outreach/startup/AI and UI checks.
# This does not rebuild or modify the already-verified release tree.
$workspaceDir = Split-Path -Parent $PSScriptRoot
$nodePath = Join-Path $workspaceDir 'dy-lead-app\node.exe'
$packagePath = Join-Path $workspaceDir 'dy-lead-app-release\resources\app\package.json'
if ((Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json).version -ne '2.2.15') { throw 'Unexpected release version' }
foreach ($check in @('verify-browser-sandbox.js', 'verify-browser-portability.js', 'verify-license.js', 'verify-legacy-preflight.js')) {
    & $nodePath (Join-Path $PSScriptRoot $check)
    if ($LASTEXITCODE -ne 0) { throw ('Verification failed: ' + $check) }
}
& (Join-Path $PSScriptRoot 'verify-desktop.ps1')
& 'C:/Users/HUAMAO/AppData/Local/Programs/Inno Setup 7/ISCC.exe' /Q (Join-Path $PSScriptRoot 'setup.iss')
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archivePath = Join-Path $workspaceDir '华贸获客-程序包-2.2.15.zip'
if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath }
[System.IO.Compression.ZipFile]::CreateFromDirectory((Join-Path $workspaceDir 'dy-lead-app-release'), $archivePath)
& (Join-Path $PSScriptRoot 'verify-artifacts.ps1')
Write-Output '独立客户端安装包和绿色版已生成'
