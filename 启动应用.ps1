<#
.SYNOPSIS
    抖音索引桌面应用一键启动脚本 (PowerShell)
.DESCRIPTION
    自动检查环境并启动抖音索引开发模式
#>

$ErrorActionPreference = "Stop"
$script:BaseDir = Split-Path $MyInvocation.MyCommand.Path -Parent

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "    抖音索引桌面应用 - 一键启动" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "[1/3] 检查环境..." -ForegroundColor Gray

# Check Node.js
try {
    $nodeVersion = & node --version 2>&1
    Write-Host "[OK] Node.js: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "ERROR: 未找到 Node.js，请先安装" -ForegroundColor Red
    Write-Host "下载地址: https://nodejs.org/" -ForegroundColor Yellow
    Read-Host "按 Enter 退出"
    exit 1
}

# Check npm
try {
    $npmVersion = & npm --version 2>&1
    Write-Host "[OK] npm: $npmVersion" -ForegroundColor Green
} catch {
    Write-Host "ERROR: 未找到 npm" -ForegroundColor Red
    Read-Host "按 Enter 退出"
    exit 1
}

# Check Rust/cargo
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
try {
    $cargoVersion = & cargo --version 2>&1
    Write-Host "[OK] cargo: $cargoVersion" -ForegroundColor Green
} catch {
    Write-Host "ERROR: 未找到 Rust/cargo，请先安装" -ForegroundColor Red
    Write-Host "下载地址: https://www.rust-lang.org/tools/install" -ForegroundColor Yellow
    Read-Host "按 Enter 退出"
    exit 1
}

Write-Host ""
Write-Host "[2/3] 检查依赖..." -ForegroundColor Gray

if (-not (Test-Path "$BaseDir\node_modules")) {
    Write-Host "正在安装 npm 依赖..." -ForegroundColor Yellow
    Push-Location $BaseDir
    try {
        & npm install
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed"
        }
    } finally {
        Pop-Location
    }
}
Write-Host "[OK] npm 依赖已就绪" -ForegroundColor Green

Write-Host ""
Write-Host "[3/3] 启动应用..." -ForegroundColor Gray
Write-Host ""
Write-Host "首次启动可能需要较长时间编译 Rust 代码，请耐心等待..." -ForegroundColor Yellow
Write-Host "应用窗口将在编译完成后自动打开" -ForegroundColor Yellow
Write-Host ""

Push-Location $BaseDir
try {
    & npm run tauri dev
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "ERROR: 应用启动失败，请检查上述错误信息" -ForegroundColor Red
        Read-Host "按 Enter 退出"
    }
} finally {
    Pop-Location
}
