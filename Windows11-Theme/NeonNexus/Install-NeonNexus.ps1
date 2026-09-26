# =====================================================================================
# NEON NEXUS - Windows 11 Theme Installer
# Author  : Nick Butcher
# GitHub  : https://github.com/nihkb007/Intune-Repository
# Created : 2026-09-26
# Version : 1.0
#
# Description:
# Installs the NEON NEXUS theme for the current user:
#   - Dark mode for apps + system, transparency on
#   - Hand-built 8-colour accent palette (Start, taskbar, title bars, borders)
#   - 4K procedurally rendered wallpapers (static or slideshow)
#   - Lock screen image (no admin needed)
#   - Windows Terminal colour scheme + profile (fragment, settings.json untouched)
#   - Every accent registered as a theme in Settings > Personalization > Themes
#   - Full backup of your current look; Uninstall-NeonNexus.ps1 restores it
#
# Usage:
#   Double-click Install.cmd                     (interactive picker)
#   .\Install-NeonNexus.ps1 -Accent Toxic -Wallpaper Flux
#   .\Install-NeonNexus.ps1 -Accent Cyan -Silent (no prompts)
#
# =====================================================================================
[CmdletBinding()]
param(
    [ValidateSet('Cyan', 'Magenta', 'Violet', 'Toxic', 'Ember')]
    [string]$Accent = 'Cyan',

    [ValidateSet('Horizon', 'Flux', 'Slideshow')]
    [string]$Wallpaper = 'Horizon',

    [switch]$TaskbarLeft,
    [switch]$SkipTerminal,
    [switch]$SkipLockScreen,
    [switch]$RestartExplorer,
    [switch]$Silent
)

$ErrorActionPreference = 'Stop'
$ThemeVersion = '1.0'

# =========================================
# CONFIGURATION
# =========================================
$Accents = [ordered]@{
    Cyan    = @{ Primary = '#00E5FF'; Secondary = '#FF2E88'; Tag = 'Electric cyan / hot pink' }
    Magenta = @{ Primary = '#FF2E88'; Secondary = '#7A5CFF'; Tag = 'Hot pink / ultraviolet' }
    Violet  = @{ Primary = '#9D4DFF'; Secondary = '#00E5FF'; Tag = 'Ultraviolet / cyan' }
    Toxic   = @{ Primary = '#39FF14'; Secondary = '#00B3FF'; Tag = 'Acid green / ice blue' }
    Ember   = @{ Primary = '#FF6A00'; Secondary = '#FF1F4B'; Tag = 'Molten orange / crimson' }
}

$SourceRoot   = $PSScriptRoot
$InstallDir   = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Themes\NeonNexus'
$WallDir      = Join-Path $InstallDir 'Wallpapers'
$StateDir     = Join-Path $env:LOCALAPPDATA 'NeonNexus'
$BackupFile   = Join-Path $StateDir 'backup.json'
$LogFile      = Join-Path $StateDir 'install.log'
$FragmentDir  = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows Terminal\Fragments\NeonNexus'
$MarkerKey    = 'HKCU:\Software\NeonNexus'

$KeyPersonalize = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
$KeyDwm         = 'HKCU:\Software\Microsoft\Windows\DWM'
$KeyAccent      = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Accent'
$KeyDesktop     = 'HKCU:\Control Panel\Desktop'
$KeyAdvanced    = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced'
$KeyThemes      = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes'

# Every value this installer touches - snapshotted before the first install
$BackupTargets = @(
    @{ Path = $KeyPersonalize; Name = 'AppsUseLightTheme' }
    @{ Path = $KeyPersonalize; Name = 'SystemUsesLightTheme' }
    @{ Path = $KeyPersonalize; Name = 'EnableTransparency' }
    @{ Path = $KeyPersonalize; Name = 'ColorPrevalence' }
    @{ Path = $KeyDwm;         Name = 'ColorPrevalence' }
    @{ Path = $KeyDwm;         Name = 'AccentColor' }
    @{ Path = $KeyDwm;         Name = 'AccentColorInactive' }
    @{ Path = $KeyDwm;         Name = 'ColorizationColor' }
    @{ Path = $KeyDwm;         Name = 'ColorizationAfterglow' }
    @{ Path = $KeyAccent;      Name = 'AccentPalette' }
    @{ Path = $KeyAccent;      Name = 'AccentColorMenu' }
    @{ Path = $KeyAccent;      Name = 'StartColorMenu' }
    @{ Path = $KeyDesktop;     Name = 'WallPaper' }
    @{ Path = $KeyDesktop;     Name = 'WallpaperStyle' }
    @{ Path = $KeyDesktop;     Name = 'TileWallpaper' }
    @{ Path = $KeyDesktop;     Name = 'AutoColorization' }
    @{ Path = $KeyAdvanced;    Name = 'TaskbarAl' }
    @{ Path = $KeyThemes;      Name = 'CurrentTheme' }
)

# =========================================
# LOGGING / UI
# =========================================
$Esc = [char]27
function Get-Ansi([string]$Hex) {
    $r = [Convert]::ToInt32($Hex.Substring(1, 2), 16)
    $g = [Convert]::ToInt32($Hex.Substring(3, 2), 16)
    $b = [Convert]::ToInt32($Hex.Substring(5, 2), 16)
    return "$Esc[38;2;$r;$g;${b}m"
}
$Reset = "$Esc[0m"

function Write-Log {
    param([string]$Message, [ValidateSet('INFO', 'OK', 'WARN', 'ERROR')][string]$Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch { }
    $color = @{ INFO = 'Gray'; OK = 'Green'; WARN = 'Yellow'; ERROR = 'Red' }[$Level]
    $glyph = @{ INFO = '[..]'; OK = '[OK]'; WARN = '[!!]'; ERROR = '[XX]' }[$Level]
    Write-Host "  $glyph $Message" -ForegroundColor $color
}

function Show-Banner([string]$Hex) {
    $c = Get-Ansi $Hex
    $art = @(
        '  ███╗   ██╗███████╗ ██████╗ ███╗   ██╗    ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗'
        '  ████╗  ██║██╔════╝██╔═══██╗████╗  ██║    ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝'
        '  ██╔██╗ ██║█████╗  ██║   ██║██╔██╗ ██║    ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗'
        '  ██║╚██╗██║██╔══╝  ██║   ██║██║╚██╗██║    ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║'
        '  ██║ ╚████║███████╗╚██████╔╝██║ ╚████║    ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║'
        '  ╚═╝  ╚═══╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝    ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝'
    )
    Write-Host ''
    foreach ($l in $art) { Write-Host "$c$l$Reset" }
    Write-Host "$c  // Windows 11 theme  v$ThemeVersion$Reset"
    Write-Host ''
}

# =========================================
# COLOUR MATH
# =========================================
function ConvertFrom-Hex([string]$Hex) {
    return @(
        [Convert]::ToInt32($Hex.Substring(1, 2), 16),
        [Convert]::ToInt32($Hex.Substring(3, 2), 16),
        [Convert]::ToInt32($Hex.Substring(5, 2), 16)
    )
}

function ConvertTo-Hsl([int[]]$Rgb) {
    $r = $Rgb[0] / 255.0; $g = $Rgb[1] / 255.0; $b = $Rgb[2] / 255.0
    $max = [Math]::Max($r, [Math]::Max($g, $b)); $min = [Math]::Min($r, [Math]::Min($g, $b))
    $l = ($max + $min) / 2; $h = 0.0; $s = 0.0
    if ($max -ne $min) {
        $d = $max - $min
        if ($l -gt 0.5) { $s = $d / (2 - $max - $min) } else { $s = $d / ($max + $min) }
        if ($max -eq $r)     { $h = (($g - $b) / $d) + $(if ($g -lt $b) { 6 } else { 0 }) }
        elseif ($max -eq $g) { $h = (($b - $r) / $d) + 2 }
        else                 { $h = (($r - $g) / $d) + 4 }
        $h /= 6
    }
    return @($h, $s, $l)
}

function ConvertFrom-Hsl([double]$H, [double]$S, [double]$L) {
    function HueToRgb([double]$p, [double]$q, [double]$t) {
        if ($t -lt 0) { $t += 1 }; if ($t -gt 1) { $t -= 1 }
        if ($t -lt 1 / 6) { return $p + ($q - $p) * 6 * $t }
        if ($t -lt 1 / 2) { return $q }
        if ($t -lt 2 / 3) { return $p + ($q - $p) * (2 / 3 - $t) * 6 }
        return $p
    }
    $L = [Math]::Min(1.0, [Math]::Max(0.0, $L))
    if ($S -eq 0) { $r = $g = $b = $L }
    else {
        if ($L -lt 0.5) { $q = $L * (1 + $S) } else { $q = $L + $S - $L * $S }
        $p = 2 * $L - $q
        $r = HueToRgb $p $q ($H + 1 / 3); $g = HueToRgb $p $q $H; $b = HueToRgb $p $q ($H - 1 / 3)
    }
    return @([int][Math]::Round($r * 255), [int][Math]::Round($g * 255), [int][Math]::Round($b * 255))
}

# Windows' AccentPalette = 8 RGBA swatches: Light3, Light2, Light1, Accent,
# Dark1, Dark2, Dark3, Complement. We build them from the neon primary.
function Get-AccentPalette([string]$PrimaryHex, [string]$SecondaryHex) {
    $hsl = ConvertTo-Hsl (ConvertFrom-Hex $PrimaryHex)
    $steps = @(0.30, 0.20, 0.10, 0.0, -0.12, -0.24, -0.36)
    $swatches = foreach ($d in $steps) { , (ConvertFrom-Hsl $hsl[0] $hsl[1] ($hsl[2] + $d)) }
    $swatches += , (ConvertFrom-Hex $SecondaryHex)
    return $swatches
}

function ConvertTo-Abgr([int[]]$Rgb) {
    # DWORD whose little-endian bytes are R,G,B,A -> 0xAABBGGRR
    return [BitConverter]::ToInt32([byte[]]@($Rgb[0], $Rgb[1], $Rgb[2], 0xFF), 0)
}

function ConvertTo-Argb([int[]]$Rgb, [int]$Alpha = 0xC4) {
    return [BitConverter]::ToInt32([byte[]]@($Rgb[2], $Rgb[1], $Rgb[0], $Alpha), 0)
}

function ConvertTo-HexString([int[]]$Rgb) {
    return '#{0:X2}{1:X2}{2:X2}' -f $Rgb[0], $Rgb[1], $Rgb[2]
}

# =========================================
# REGISTRY HELPERS
# =========================================
function Set-RegValue([string]$Path, [string]$Name, $Value, [string]$Type = 'DWord') {
    if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
    New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null
}

function Save-Backup {
    if (Test-Path $BackupFile) {
        Write-Log 'Existing backup found - keeping your original look (not overwriting)' 'INFO'
        return
    }
    $entries = foreach ($t in $BackupTargets) {
        $entry = [ordered]@{ Path = $t.Path; Name = $t.Name; Exists = $false; Kind = $null; Value = $null }
        if (Test-Path $t.Path) {
            $key = Get-Item -Path $t.Path
            if ($key.GetValueNames() -contains $t.Name) {
                $kind = $key.GetValueKind($t.Name).ToString()
                $raw  = $key.GetValue($t.Name, $null, 'DoNotExpandEnvironmentNames')
                if ($kind -eq 'Binary') { $raw = [Convert]::ToBase64String([byte[]]$raw) }
                $entry.Exists = $true; $entry.Kind = $kind; $entry.Value = $raw
            }
        }
        [pscustomobject]$entry
    }
    [pscustomobject]@{
        CreatedOn = (Get-Date).ToString('o')
        Computer  = $env:COMPUTERNAME
        User      = $env:USERNAME
        Values    = @($entries)
    } | ConvertTo-Json -Depth 5 | Set-Content -Path $BackupFile -Encoding UTF8
    Write-Log "Backed up $(@($entries).Count) personalization values -> $BackupFile" 'OK'
}

# =========================================
# WIN32 / WINRT INTEROP
# =========================================
if (-not ('NeonNexus.Native' -as [type])) {
    Add-Type -Namespace NeonNexus -Name Native -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, string pvParam, uint fWinIni);

[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
}

function Set-Wallpaper([string]$Path) {
    Set-RegValue $KeyDesktop 'WallpaperStyle' '10' 'String'   # Fill
    Set-RegValue $KeyDesktop 'TileWallpaper' '0' 'String'
    # SPI_SETDESKWALLPAPER = 0x14, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE = 3
    if (-not [NeonNexus.Native]::SystemParametersInfo(0x14, 0, $Path, 3)) {
        throw "SystemParametersInfo failed for $Path"
    }
}

function Send-SettingChange {
    $result = [UIntPtr]::Zero
    foreach ($area in 'ImmersiveColorSet', 'WindowsThemeElement', 'TraySettings') {
        # HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG
        [void][NeonNexus.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, $area, 2, 3000, [ref]$result)
    }
}

function Set-LockScreenImage([string]$Path) {
    if ($PSVersionTable.PSEdition -ne 'Desktop') {
        Write-Log 'Lock screen needs Windows PowerShell 5.1 (WinRT) - skipped. Run via Install.cmd.' 'WARN'
        return
    }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $ext = [System.WindowsRuntimeSystemExtensions].GetMethods()
    $asTaskOp  = $ext | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
    $asTaskAct = $ext | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1

    $null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
    $null = [Windows.System.UserProfile.LockScreen,Windows.System.UserProfile,ContentType=WindowsRuntime]

    $opFile = [Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)
    $task = $asTaskOp.MakeGenericMethod([Windows.Storage.StorageFile]).Invoke($null, @($opFile))
    [void]$task.Wait(15000)
    $file = $task.Result

    $task2 = $asTaskAct.Invoke($null, @([Windows.System.UserProfile.LockScreen]::SetImageFileAsync($file)))
    [void]$task2.Wait(15000)
    if ($task2.IsFaulted) { throw $task2.Exception.InnerException }
}

# =========================================
# INTERACTIVE PICKER
# =========================================
function Read-Choice([string]$Prompt, [string[]]$Options, [string]$Default) {
    while ($true) {
        $answer = Read-Host "  $Prompt [$Default]"
        if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
        if ($answer -match '^\d+$' -and [int]$answer -ge 1 -and [int]$answer -le $Options.Count) {
            return $Options[[int]$answer - 1]
        }
        $hit = $Options | Where-Object { $_ -like "$answer*" } | Select-Object -First 1
        if ($hit) { return $hit }
        Write-Host '  Invalid choice, try again.' -ForegroundColor Yellow
    }
}

# =========================================
# MAIN
# =========================================
if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) {
    throw 'NEON NEXUS installs on Windows 10/11 only.'
}
New-Item -ItemType Directory -Path $StateDir, $InstallDir, $WallDir -Force | Out-Null

if (-not $Silent) {
    Show-Banner $Accents[$Accent].Primary
    if (-not $PSBoundParameters.ContainsKey('Accent')) {
        Write-Host '  Choose your accent:'
        $i = 1
        foreach ($name in $Accents.Keys) {
            $a = $Accents[$name]
            $sw = "$(Get-Ansi $a.Primary)████$(Get-Ansi $a.Secondary)██$Reset"
            Write-Host ('   {0}) {1}  {2,-8} {3}' -f $i, $sw, $name, $a.Tag)
            $i++
        }
        $Accent = Read-Choice 'Accent (number or name)' @($Accents.Keys) $Accent
    }
    if (-not $PSBoundParameters.ContainsKey('Wallpaper')) {
        Write-Host ''
        Write-Host '  Choose your wallpaper:'
        Write-Host '   1) Horizon    - synthwave skyline over a neon grid'
        Write-Host '   2) Flux       - flowing data ribbons with HUD rings'
        Write-Host '   3) Slideshow  - rotate all 10 wallpapers every 30 min'
        $Wallpaper = Read-Choice 'Wallpaper (number or name)' @('Horizon', 'Flux', 'Slideshow') $Wallpaper
    }
    Write-Host ''
}

$colors    = $Accents[$Accent]
$palette   = Get-AccentPalette $colors.Primary $colors.Secondary
$accentKey = $Accent.ToLower()

Write-Log "Installing NEON NEXUS v$ThemeVersion  (accent: $Accent, wallpaper: $Wallpaper)"

# 1. Backup ---------------------------------------------------------------
Save-Backup

# 2. Assets ---------------------------------------------------------------
$srcWalls = Join-Path $SourceRoot 'Wallpapers'
if (-not (Test-Path $srcWalls)) { throw "Wallpapers folder not found next to the installer: $srcWalls" }
Copy-Item -Path (Join-Path $srcWalls '*.jpg') -Destination $WallDir -Force
$wallCount = @(Get-ChildItem $WallDir -Filter '*.jpg').Count
Write-Log "Deployed $wallCount 4K wallpapers -> $WallDir" 'OK'

$style = if ($Wallpaper -eq 'Flux') { 'flux' } else { 'horizon' }
$wallPath = Join-Path $WallDir "nexus-$style-$accentKey.jpg"

# 3. Theme files (one per accent + slideshow) -----------------------------
$template = Get-Content -Path (Join-Path $SourceRoot 'Theme\NeonNexus.theme.template') -Raw
function New-ThemeFile([string]$Name, [string]$DisplayName, [string]$Wall, [int[]]$Rgb, [string]$Slideshow) {
    $colorization = '0X{0:X8}' -f (ConvertTo-Argb $Rgb)
    $themeId = '{' + [guid]::NewGuid().ToString().ToUpper() + '}'
    $content = $template.Replace('{{DISPLAYNAME}}', $DisplayName)
    $content = $content.Replace('{{THEMEID}}', $themeId)
    $content = $content.Replace('{{WALLPAPER}}', $Wall)
    $content = $content.Replace('{{COLORIZATION}}', $colorization)
    $content = $content.Replace('{{SLIDESHOW}}', $Slideshow)
    $path = Join-Path $InstallDir "$Name.theme"
    Set-Content -Path $path -Value $content -Encoding Unicode
    return $path
}

foreach ($name in $Accents.Keys) {
    $k = $name.ToLower()
    [void](New-ThemeFile "NeonNexus-$name" "NEON NEXUS // $name" (Join-Path $WallDir "nexus-horizon-$k.jpg") (ConvertFrom-Hex $Accents[$name].Primary) '')
}
$items = Get-ChildItem $WallDir -Filter '*.jpg' | Sort-Object Name
$slideshow = "`r`n[Slideshow]`r`nInterval=1800000`r`nShuffle=1`r`nImagesRootPath=$WallDir`r`n"
for ($n = 0; $n -lt $items.Count; $n++) { $slideshow += "Item${n}Path=$($items[$n].FullName)`r`n" }
$cycleTheme = New-ThemeFile 'NeonNexus-Cycle' "NEON NEXUS // Cycle ($Accent)" $wallPath (ConvertFrom-Hex $colors.Primary) $slideshow
Write-Log "Registered $($Accents.Count + 1) themes in Settings > Personalization > Themes" 'OK'

# 4. Accent palette + dark mode -------------------------------------------
$paletteBytes = New-Object byte[] 32
for ($n = 0; $n -lt 8; $n++) {
    $paletteBytes[$n * 4]     = $palette[$n][0]
    $paletteBytes[$n * 4 + 1] = $palette[$n][1]
    $paletteBytes[$n * 4 + 2] = $palette[$n][2]
    $paletteBytes[$n * 4 + 3] = 0
}
$accentMain = $palette[3]; $accentDark = $palette[4]

Set-RegValue $KeyDesktop     'AutoColorization'     '0' 'String'
Set-RegValue $KeyAccent      'AccentPalette'        $paletteBytes 'Binary'
Set-RegValue $KeyAccent      'AccentColorMenu'      (ConvertTo-Abgr $accentMain)
Set-RegValue $KeyAccent      'StartColorMenu'       (ConvertTo-Abgr $accentDark)
Set-RegValue $KeyDwm         'AccentColor'          (ConvertTo-Abgr $accentMain)
Set-RegValue $KeyDwm         'AccentColorInactive'  (ConvertTo-Abgr $palette[5])
Set-RegValue $KeyDwm         'ColorizationColor'    (ConvertTo-Argb $accentMain)
Set-RegValue $KeyDwm         'ColorizationAfterglow' (ConvertTo-Argb $accentMain)
Set-RegValue $KeyDwm         'ColorPrevalence'      1   # accent on title bars + window borders
Set-RegValue $KeyPersonalize 'ColorPrevalence'      1   # accent on Start + taskbar
Set-RegValue $KeyPersonalize 'AppsUseLightTheme'    0
Set-RegValue $KeyPersonalize 'SystemUsesLightTheme' 0
Set-RegValue $KeyPersonalize 'EnableTransparency'   1
Write-Log ("Accent palette applied: " + (($palette | ForEach-Object { ConvertTo-HexString $_ }) -join ' ')) 'OK'
Write-Log 'Dark mode + transparency + accent on Start/taskbar/title bars enabled' 'OK'

if ($TaskbarLeft) {
    try { Set-RegValue $KeyAdvanced 'TaskbarAl' 0; Write-Log 'Taskbar aligned left' 'OK' }
    catch { Write-Log "Could not set taskbar alignment: $($_.Exception.Message)" 'WARN' }
}

# 5. Wallpaper --------------------------------------------------------------
if ($Wallpaper -eq 'Slideshow') {
    # Slideshows can only be driven through a .theme file - let Windows apply it,
    # then close the Settings window it pops up. Re-assert our exact palette after.
    Start-Process -FilePath $cycleTheme
    $deadline = (Get-Date).AddSeconds(15)
    do { Start-Sleep -Milliseconds 500 } until ((Get-Process SystemSettings -ErrorAction SilentlyContinue) -or (Get-Date) -gt $deadline)
    Start-Sleep -Seconds 2
    Get-Process SystemSettings -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Set-RegValue $KeyAccent 'AccentPalette' $paletteBytes 'Binary'
    Set-RegValue $KeyAccent 'StartColorMenu' (ConvertTo-Abgr $accentDark)
    Set-RegValue $KeyAccent 'AccentColorMenu' (ConvertTo-Abgr $accentMain)
    Write-Log 'Slideshow theme applied (10 wallpapers, 30 min shuffle)' 'OK'
}
else {
    Set-Wallpaper $wallPath
    Set-RegValue $KeyThemes 'CurrentTheme' (Join-Path $InstallDir "NeonNexus-$Accent.theme") 'String'
    Write-Log "Wallpaper set: $(Split-Path $wallPath -Leaf)" 'OK'
}

# 6. Lock screen ------------------------------------------------------------
if (-not $SkipLockScreen) {
    try {
        Set-LockScreenImage (Join-Path $WallDir "nexus-flux-$accentKey.jpg")
        Write-Log 'Lock screen image set' 'OK'
    }
    catch { Write-Log "Lock screen not changed (policy-managed or unsupported): $($_.Exception.Message)" 'WARN' }
}

# 7. Windows Terminal -------------------------------------------------------
if (-not $SkipTerminal) {
    try {
        New-Item -ItemType Directory -Path $FragmentDir -Force | Out-Null
        $fragment = (Get-Content -Path (Join-Path $SourceRoot 'Terminal\neon-nexus.json') -Raw).Replace('{{ACCENT}}', $colors.Primary)
        # Terminal expects UTF-8 without BOM
        [IO.File]::WriteAllText((Join-Path $FragmentDir 'neon-nexus.json'), $fragment, (New-Object Text.UTF8Encoding $false))
        Write-Log 'Windows Terminal scheme "Neon Nexus" + profile installed' 'OK'
    }
    catch { Write-Log "Windows Terminal fragment skipped: $($_.Exception.Message)" 'WARN' }
}

# 8. Install marker ------------------------------------------------------------
Set-RegValue $MarkerKey 'Version'     $ThemeVersion 'String'
Set-RegValue $MarkerKey 'Accent'      $Accent 'String'
Set-RegValue $MarkerKey 'Wallpaper'   $Wallpaper 'String'
Set-RegValue $MarkerKey 'InstallDir'  $InstallDir 'String'
Set-RegValue $MarkerKey 'InstalledOn' (Get-Date).ToString('o') 'String'

# 9. Refresh the shell ------------------------------------------------------
Send-SettingChange
if ($RestartExplorer) {
    Write-Log 'Restarting Explorer to repaint the taskbar'
    Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }
}

if (-not $Silent) {
    $c = Get-Ansi $colors.Primary
    Write-Host ''
    Write-Host "$c  >> NEON NEXUS is live. Welcome to the grid.$Reset"
    Write-Host '     Switch accents any time: Settings > Personalization > Themes'
    Write-Host '     Restore your old look:   Uninstall.cmd'
    if (-not $RestartExplorer) { Write-Host '     Taskbar colour not updated? Sign out/in or re-run with -RestartExplorer' }
    Write-Host ''
}
Write-Log 'Install complete' 'OK'
exit 0
