# =====================================================================================
# NEON NEXUS - Windows 11 Theme Uninstaller
# Author  : Nick Butcher
# GitHub  : https://github.com/nihkb007/Intune-Repository
# Created : 2026-09-26
# Version : 1.0
#
# Description:
# Restores every personalization value captured by Install-NeonNexus.ps1,
# resets the wallpaper, and removes the theme files, Terminal fragment and marker.
#
# Usage:
#   Double-click Uninstall.cmd
#   .\Uninstall-NeonNexus.ps1 [-KeepFiles] [-RestartExplorer] [-Silent]
#
# =====================================================================================
[CmdletBinding()]
param(
    [switch]$KeepFiles,
    [switch]$RestartExplorer,
    [switch]$Silent
)

$ErrorActionPreference = 'Stop'

$InstallDir  = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Themes\NeonNexus'
$StateDir    = Join-Path $env:LOCALAPPDATA 'NeonNexus'
$BackupFile  = Join-Path $StateDir 'backup.json'
$LogFile     = Join-Path $StateDir 'install.log'
$FragmentDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows Terminal\Fragments\NeonNexus'
$MarkerKey   = 'HKCU:\Software\NeonNexus'
$KeyDesktop  = 'HKCU:\Control Panel\Desktop'

function Write-Log {
    param([string]$Message, [ValidateSet('INFO', 'OK', 'WARN', 'ERROR')][string]$Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    try { if (Test-Path $StateDir) { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } } catch { }
    $color = @{ INFO = 'Gray'; OK = 'Green'; WARN = 'Yellow'; ERROR = 'Red' }[$Level]
    $glyph = @{ INFO = '[..]'; OK = '[OK]'; WARN = '[!!]'; ERROR = '[XX]' }[$Level]
    Write-Host "  $glyph $Message" -ForegroundColor $color
}

if (-not ('NeonNexus.Native' -as [type])) {
    Add-Type -Namespace NeonNexus -Name Native -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, string pvParam, uint fWinIni);

[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
}

if (-not $Silent) { Write-Host ''; Write-Host '  NEON NEXUS // uninstall' -ForegroundColor Cyan; Write-Host '' }

# 1. Restore registry snapshot ---------------------------------------------
$wallpaper = $null
if (Test-Path $BackupFile) {
    $backup = Get-Content -Path $BackupFile -Raw | ConvertFrom-Json
    foreach ($v in $backup.Values) {
        try {
            if ($v.Exists) {
                if (-not (Test-Path $v.Path)) { New-Item -Path $v.Path -Force | Out-Null }
                $value = $v.Value
                switch ($v.Kind) {
                    'Binary' { $value = [Convert]::FromBase64String($value) }
                    'DWord'  { $value = [int]$value }
                    'QWord'  { $value = [long]$value }
                }
                New-ItemProperty -Path $v.Path -Name $v.Name -Value $value -PropertyType $v.Kind -Force | Out-Null
                if ($v.Path -eq $KeyDesktop -and $v.Name -eq 'WallPaper') { $wallpaper = [string]$value }
            }
            elseif (Test-Path $v.Path) {
                Remove-ItemProperty -Path $v.Path -Name $v.Name -ErrorAction SilentlyContinue
            }
        }
        catch { Write-Log "Could not restore $($v.Path)\$($v.Name): $($_.Exception.Message)" 'WARN' }
    }
    Write-Log "Restored $(@($backup.Values).Count) personalization values from $($backup.CreatedOn)" 'OK'
}
else {
    Write-Log 'No backup found - reverting to Windows automatic accent colour' 'WARN'
    Set-ItemProperty -Path $KeyDesktop -Name 'AutoColorization' -Value '1'
}

# 2. Wallpaper ---------------------------------------------------------------
if (-not $wallpaper -or -not (Test-Path ([Environment]::ExpandEnvironmentVariables($wallpaper)))) {
    $wallpaper = Join-Path $env:WINDIR 'Web\Wallpaper\Windows\img0.jpg'
}
$wallpaper = [Environment]::ExpandEnvironmentVariables($wallpaper)
[void][NeonNexus.Native]::SystemParametersInfo(0x14, 0, $wallpaper, 3)
Write-Log "Wallpaper restored: $wallpaper" 'OK'

# 3. Files -------------------------------------------------------------------
if (Test-Path $FragmentDir) { Remove-Item $FragmentDir -Recurse -Force; Write-Log 'Removed Windows Terminal fragment' 'OK' }
if (-not $KeepFiles) {
    if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force; Write-Log 'Removed theme files and wallpapers' 'OK' }
    if (Test-Path $StateDir)   { Remove-Item $StateDir -Recurse -Force }
}
if (Test-Path $MarkerKey) { Remove-Item $MarkerKey -Recurse -Force }

# 4. Refresh -----------------------------------------------------------------
$result = [UIntPtr]::Zero
foreach ($area in 'ImmersiveColorSet', 'WindowsThemeElement', 'TraySettings') {
    [void][NeonNexus.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, $area, 2, 3000, [ref]$result)
}
if ($RestartExplorer) {
    Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }
}

Write-Host '  [OK] NEON NEXUS removed. Your previous look is back.' -ForegroundColor Green
Write-Host '       (The lock screen image is left as-is; change it in Settings > Personalization > Lock screen.)' -ForegroundColor Gray
exit 0
