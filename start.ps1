# Windows 上启动会议记录服务：http://127.0.0.1:8770
# 用法（PowerShell）：.\start.ps1    提示“禁止运行脚本”时：powershell -ExecutionPolicy Bypass -File start.ps1
Set-Location $PSScriptRoot
$env:PYTHONUTF8 = "1"  # 中文文件名、设备名、日志按 UTF-8 处理，不用系统默认的 GBK
$venv = if ($env:VIRTUAL_ENV) { $env:VIRTUAL_ENV } else { ".venv" }
$py = Join-Path $venv "Scripts\python.exe"
if (-not $env:UV_NO_SYNC) {
    if (Test-Path (Join-Path $venv ".no-uv-sync")) {
        $env:UV_NO_SYNC = "1"
    } elseif (Test-Path $py) {
        & $py -c "import torch, sys; sys.exit(0 if '+cu' in torch.__version__ else 1)" 2>$null
        if ($LASTEXITCODE -eq 0) { $env:UV_NO_SYNC = "1" }
    }
}
$port = if ($env:PORT) { $env:PORT } else { "8770" }
uv run uvicorn app:app --host 127.0.0.1 --port $port
exit $LASTEXITCODE
