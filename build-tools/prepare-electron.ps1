$ErrorActionPreference = 'Stop'
$runtimeVersion = '44.6.0'
$runtimeArchive = Join-Path $PSScriptRoot ('electron-v' + $runtimeVersion + '-win32-x64.zip')
$runtimeDirectory = Join-Path $PSScriptRoot ('electron-runtime-' + $runtimeVersion)
$expectedDigest = '04d6071f8deca081044e1398f96f65e4c1550ffdb3f882504cd78528d821d422'
if (!(Test-Path -LiteralPath $runtimeArchive)) {
    Invoke-WebRequest -Uri ('https://github.com/electron/electron/releases/download/v' + $runtimeVersion + '/electron-v' + $runtimeVersion + '-win32-x64.zip') -OutFile $runtimeArchive
}
if ((Get-FileHash -LiteralPath $runtimeArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedDigest) { throw 'Electron 官方压缩包 SHA256 校验失败' }
Expand-Archive -LiteralPath $runtimeArchive -DestinationPath $runtimeDirectory -Force
Write-Output ('已校验并解压 Electron ' + $runtimeVersion)
