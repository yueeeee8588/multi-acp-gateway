@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [acp-gateway-8048] 多功能 ACP 聚合网关 - 8048 ACP 伴生服务
echo [acp-gateway-8048] Launching detached supervisor with zero window (wscript SW_HIDE)...
wscript.exe //B //Nologo "%~dp0launch_8048_silent.vbs"

echo [acp-gateway-8048] Supervisor is responsible for keep-alive + auto-restart on crash.
echo [acp-gateway-8048] Logs: data\8048.supervisor.log / data\8048.out.log / data\8048.err.log
