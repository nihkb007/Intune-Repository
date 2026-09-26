@echo off
title NEON NEXUS // Installer
rem Launches the installer with Windows PowerShell 5.1 (needed for the lock screen API).
rem Any arguments are passed through, e.g.  Install.cmd -Accent Toxic -Wallpaper Flux
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-NeonNexus.ps1" %*
echo.
pause
