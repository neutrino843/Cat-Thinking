@echo off
chcp 65001 >nul
if not exist "%~dp0Start-CatThinking.cmd" (
  echo 启动文件不完整，请恢复同一文件夹里的 Start-CatThinking.cmd。
  pause
  exit /b 1
)
call "%~dp0Start-CatThinking.cmd"
exit /b %ERRORLEVEL%
