@echo off
rem Chrome 在 Windows 上只能执行 .exe/.bat，所以用它包一层 python 脚本。
rem 这个文件的所有输出都会进 Native Messaging 的 stdout 协议通道，
rem 所以除了脚本自己的二进制消息外，一个字都不能打印。
chcp 65001 >nul
cd /d "%~dp0.."
set "PY=D:\miniconda\envs\py311\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" "%~dp0..\python\native_host.py" %*
