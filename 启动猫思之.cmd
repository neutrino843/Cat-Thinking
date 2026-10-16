@echo off
chcp 65001 >nul
if exist "%~dp0Start-CatThinking.cmd" goto start_here
if exist "%~dp0cat-thinking\Start-CatThinking.cmd" goto start_child
echo 请先右键 ZIP 压缩包，选择“全部解压”，再打开解压后的文件夹启动。
echo 不要直接在压缩包窗口中双击启动文件；Windows 只会临时解出这一个文件。
echo 完整项目需要保留 cat-thinking 内的 Start-CatThinking.cmd、scripts 和 services 文件夹。
pause
exit /b 1

:start_here
call "%~dp0Start-CatThinking.cmd"
exit /b %ERRORLEVEL%

:start_child
call "%~dp0cat-thinking\Start-CatThinking.cmd"
exit /b %ERRORLEVEL%
