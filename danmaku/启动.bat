@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   斗法托管 · 本地识别服务
echo   起来以后在 Chrome 里点插件「开始托管」
echo   关掉这个黑窗口 = 停掉服务
echo ============================================
echo.
set HTTP_PROXY=
set HTTPS_PROXY=
set ALL_PROXY=
"D:\miniconda\envs\py311\python.exe" start.py %*
echo.
echo 服务已退出。
pause
