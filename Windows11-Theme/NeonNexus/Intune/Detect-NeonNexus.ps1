# =====================================================================================
# NEON NEXUS - Intune Win32 app detection script
# Author : Nick Butcher
# GitHub : https://github.com/nihkb007/Intune-Repository
#
# Use as a custom detection script on the Win32 app with
# "Run script as 32-bit process on 64-bit clients" = No. The app must be
# assigned with Install behavior = User so HKCU resolves to the signed-in user.
# =====================================================================================
$RequiredVersion = [version]'1.0'
$MarkerKey = 'HKCU:\Software\NeonNexus'

try {
    $installed = (Get-ItemProperty -Path $MarkerKey -Name Version -ErrorAction Stop).Version
    $themeDir  = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Themes\NeonNexus'
    if ([version]$installed -ge $RequiredVersion -and (Test-Path (Join-Path $themeDir 'NeonNexus-Cycle.theme'))) {
        Write-Output "NEON NEXUS $installed detected"
        exit 0
    }
}
catch { }
exit 1
