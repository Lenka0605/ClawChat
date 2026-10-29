@echo off
rem ClawChat for Windows: install or repair. Double-click this file.
rem The real work is done by windows\install.ps1 (all messages are in Chinese there).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\install.ps1"
if errorlevel 1 pause
