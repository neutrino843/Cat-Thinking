@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if errorlevel 1 goto missing_project
where node >nul 2>&1
if errorlevel 1 (
  echo 这台电脑需要先安装 Node.js 24，再双击启动猫思之。
  pause
  exit /b 1
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo npm 启动工具未找到。请重新安装 Node.js 24，并重新打开终端。
  pause
  exit /b 1
)
if not exist "scripts\startup-preflight.mjs" goto missing_project
node "scripts\startup-preflight.mjs"
if errorlevel 1 goto preflight_failed
echo 正在启动猫思之。请保留此窗口，并使用稍后显示的实际应用网址。
call npm.cmd run start:local
set "cat_start_exit=%ERRORLEVEL%"
if not "%cat_start_exit%"=="0" goto launch_failed
exit /b 0

:missing_project
echo 启动文件所在目录缺少完整应用。请在 cat-thinking 文件夹里启动，保留 scripts 与 services 子文件夹。
pause
exit /b 1

:preflight_failed
echo 请先按上方提示处理，再重新启动。此窗口保留错误说明。
pause
exit /b 1

:launch_failed
echo 猫思之未能完成启动。请查看上方最后的错误提示。
echo 可在此文件夹打开 PowerShell，执行 npm.cmd run start:local；不要在排查信息里包含 API 密钥。
pause
exit /b %cat_start_exit%
