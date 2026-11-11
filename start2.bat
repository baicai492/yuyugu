@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动鱼鱼谷托管（Node 主程序 + 本地 GUI 服务）...
echo 关闭本窗口即可停止。
echo.
node yuyugu2.mjs %*
pause
