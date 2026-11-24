$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeDir = Join-Path $ProjectRoot '.runtime'
$Archive = Join-Path $ProjectRoot '.runtime-node.zip'
$TempDir = Join-Path $ProjectRoot '.runtime-unpack'
$Version = '26.13.1'

if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
    $Arch = 'win-arm64'
    $ExpectedHash = '181ebe431b90787113a9e4fc80d38ce86d37888a353a0386de44d2872e48cb97'
} else {
    $Arch = 'win-x64'
    $ExpectedHash = 'e2edda75bfb089654705cf65a13b58933bfd5f57148e8ebda916f58a2474f1f7'
}

$FileName = "node-v$Version-$Arch.zip"
$Url = "https://nodejs.org/dist/v$Version/$FileName"

Write-Host "در حال دریافت Node.js رسمی نسخه $Version ($Arch)..." -ForegroundColor Cyan
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri $Url -OutFile $Archive -UseBasicParsing

$ActualHash = (Get-FileHash -Path $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualHash -ne $ExpectedHash) {
    Remove-Item $Archive -Force -ErrorAction SilentlyContinue
    throw 'بررسی امنیتی فایل Node.js ناموفق بود؛ فایل اجرا نشد.'
}

if (Test-Path $TempDir) { Remove-Item $TempDir -Recurse -Force }
if (Test-Path $RuntimeDir) { Remove-Item $RuntimeDir -Recurse -Force }
New-Item -ItemType Directory -Path $TempDir | Out-Null
Expand-Archive -Path $Archive -DestinationPath $TempDir -Force
$ExtractedDir = Join-Path $TempDir "node-v$Version-$Arch"
if (-not (Test-Path (Join-Path $ExtractedDir 'node.exe'))) {
    throw 'فایل node.exe داخل بسته پیدا نشد.'
}
New-Item -ItemType Directory -Path $RuntimeDir | Out-Null
Copy-Item -Path (Join-Path $ExtractedDir '*') -Destination $RuntimeDir -Recurse -Force
Remove-Item $Archive -Force
Remove-Item $TempDir -Recurse -Force

if (-not (Test-Path (Join-Path $RuntimeDir 'node.exe'))) {
    throw 'نصب محلی Node.js کامل نشد.'
}
Write-Host 'Node.js آماده شد.' -ForegroundColor Green
