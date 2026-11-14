@echo off
chcp 65001 >nul
cd /d "%~dp0.."
set "PY=D:\miniconda\envs\py311\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" "%~dp0..\python\native_host.py" %*
