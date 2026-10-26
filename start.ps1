# Windows 上启动会议记录服务：http://127.0.0.1:8770
# 用法（PowerShell）：.\start.ps1    提示“禁止运行脚本”时：powershell -ExecutionPolicy Bypass -File start.ps1
Set-Location $PSScriptRoot
$env:PYTHONUTF8 = "1"  # 中文文件名、设备名、日志按 UTF-8 处理，不用系统默认的 GBK
$port = if ($env:PORT) { $env:PORT } else { "8770" }
uv run uvicorn app:app --host 127.0.0.1 --port $port
exit $LASTEXITCODE
