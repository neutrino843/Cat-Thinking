@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if errorlevel 1 goto missing_project
where node >nul 2>&1
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js 24，安装后重新打开终端。
  pause
  exit /b 1
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo 未找到 npm.cmd。请重新安装 Node.js 24，安装后重新打开终端。
  pause
  exit /b 1
)
if not exist "scripts\startup-preflight.mjs" goto missing_project
node "scripts\startup-preflight.mjs"
set "cat_diagnostic_exit=%ERRORLEVEL%"
echo 此检查仅诊断 Node.js、应用文件和依赖，不连接数据库，不发送原文，也不调用模型。
echo 通过后仍无法启动时，在此文件夹的 PowerShell 中执行 npm.cmd run start:local，保留最后的报错文字。
pause
exit /b %cat_diagnostic_exit%

:missing_project
echo 应用文件不完整。请把启动入口保留在完整的 cat-thinking 文件夹中。
pause
exit /b 1
