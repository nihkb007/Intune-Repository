@echo off
title NEON NEXUS // Uninstall
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall-NeonNexus.ps1" %*
echo.
pause
