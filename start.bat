@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 鱼鱼谷托管
node yuyugu.mjs %*
pause
