# NEON NEXUS — Windows 11 Theme

A dark neon theme for Windows 11 that installs with one double-click and removes just as cleanly.

Author: Nick Butcher
GitHub: https://github.com/nihkb007/Intune-Repository

![NEON NEXUS wallpapers](preview.jpg)

---

## What You Get

- **5 accent variants**: Cyan, Magenta, Violet, Toxic, Ember. Each has its own accent color and a matching secondary color.
- **10 wallpapers at 4K (3840×2160)**, in two styles:
  - **Horizon**: a city skyline in front of a striped sun, over a glowing grid floor
  - **Flux**: flowing ribbons of light with particles and circular HUD overlays
- **A custom 8-color accent palette**, written directly to the registry. Windows normally picks these colors itself. This way Start, the taskbar, title bars and window borders get the tuned neon shades.
- **Dark mode** for both apps and Windows itself, with **transparency on**
- **Accent color on Start, the taskbar, title bars and window borders**
- **Slideshow mode**: rotates all 10 wallpapers every 30 minutes in random order
- **Lock screen image**, set through the Windows API. No admin rights needed.
- **Windows Terminal** color scheme ("Neon Nexus") plus a styled PowerShell profile with see-through acrylic and a block cursor. It's added as a *fragment*, so your `settings.json` is never edited.
- **Every variant shows up as a theme** in *Settings → Personalization → Themes*, so you can switch accents with one click.
- **Automatic backup**: your current setup is saved before any change. `Uninstall.cmd` restores it exactly.
- **No admin rights needed.** Everything is installed for the current user only.
- **Can be deployed with Intune** (see below)

---

## Install (Easy Mode)

1. Download or clone this repo.
2. Open `Windows11-Theme\NeonNexus`.
3. Double-click **`Install.cmd`**.
4. Pick an accent and a wallpaper style. Done.

> If Windows SmartScreen or "Mark of the Web" blocks the files, right-click the downloaded ZIP → *Properties* → **Unblock** *before* extracting it.

## Install (Command Line)

```powershell
# Interactive
.\Install.cmd

# Pick everything up front
.\Install.cmd -Accent Toxic -Wallpaper Flux -TaskbarLeft -RestartExplorer

# Fully unattended
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-NeonNexus.ps1 -Accent Cyan -Wallpaper Slideshow -Silent
```

| Parameter          | Values                                   | Default   | Description |
|--------------------|------------------------------------------|-----------|-------------|
| `-Accent`          | `Cyan` `Magenta` `Violet` `Toxic` `Ember` | `Cyan`    | Accent color set |
| `-Wallpaper`       | `Horizon` `Flux` `Slideshow`             | `Horizon` | Wallpaper style |
| `-TaskbarLeft`     | switch                                   | off       | Move taskbar icons to the left |
| `-SkipTerminal`    | switch                                   | off       | Don't add the Windows Terminal scheme/profile |
| `-SkipLockScreen`  | switch                                   | off       | Leave the lock screen alone |
| `-RestartExplorer` | switch                                   | off       | Restart Explorer so the taskbar picks up the new color right away |
| `-Silent`          | switch                                   | off       | No banner and no prompts (for Intune/RMM) |

## Uninstall

Double-click **`Uninstall.cmd`**, or run:

```powershell
.\Uninstall-NeonNexus.ps1 [-KeepFiles] [-RestartExplorer] [-Silent]
```

This restores every registry value from the backup (and removes any value that didn't exist before). It also puts your old wallpaper back and deletes the theme files, the Terminal fragment and the install marker.

---

## Where Things Go

| Item | Location |
|------|----------|
| Theme files + wallpapers | `%LOCALAPPDATA%\Microsoft\Windows\Themes\NeonNexus` |
| Backup + log | `%LOCALAPPDATA%\NeonNexus\backup.json`, `install.log` |
| Terminal fragment | `%LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\NeonNexus` |
| Install marker (used for detection) | `HKCU\Software\NeonNexus` |

Registry values changed (all backed up first):

- `HKCU\...\Themes\Personalize`: `AppsUseLightTheme`, `SystemUsesLightTheme`, `EnableTransparency`, `ColorPrevalence`
- `HKCU\...\DWM`: `AccentColor`, `AccentColorInactive`, `ColorizationColor`, `ColorizationAfterglow`, `ColorPrevalence`
- `HKCU\...\Explorer\Accent`: `AccentPalette`, `AccentColorMenu`, `StartColorMenu`
- `HKCU\Control Panel\Desktop`: `WallPaper`, `WallpaperStyle`, `TileWallpaper`, `AutoColorization`
- `HKCU\...\Explorer\Advanced`: `TaskbarAl` (only with `-TaskbarLeft`)

---

## Deploy with Intune (Win32 App)

1. Package the `NeonNexus` folder with the [Microsoft Win32 Content Prep Tool](https://github.com/microsoft/Microsoft-Win32-Content-Prep-Tool):
   ```
   IntuneWinAppUtil.exe -c .\NeonNexus -s Install-NeonNexus.ps1 -o .\out
   ```
2. Create a **Windows app (Win32)** with:
   - **Install command**: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File Install-NeonNexus.ps1 -Accent Cyan -Wallpaper Horizon -Silent`
   - **Uninstall command**: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File Uninstall-NeonNexus.ps1 -Silent`
   - **Install behavior**: **User**. This matters because the theme is installed per user.
   - **Detection rule**: custom script → `Intune\Detect-NeonNexus.ps1`
3. Assign it to users as *Available* (Company Portal) or *Required*.

> Organizations that enforce wallpaper, lock screen or color settings through Intune policy will override those parts. The installer logs a warning for each setting it can't change and carries on with the rest.

---

## Regenerating / Customizing the Wallpapers

The wallpapers are generated by code, so you can re-render them at any resolution or add your own color sets:

```bash
pip install pillow numpy
python Tools/generate_wallpapers.py --width 5120 --height 2880     # 5K
python Tools/generate_wallpapers.py --only toxic                   # one accent
```

Edit the `ACCENTS` table in `Tools/generate_wallpapers.py` (and the matching `$Accents` table in `Install-NeonNexus.ps1`) to add a new color set.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Taskbar still shows the old color | Re-run with `-RestartExplorer`, or sign out and back in |
| "Running scripts is disabled" | Use `Install.cmd`. It bypasses the execution policy for this one run only |
| Lock screen didn't change | It's probably controlled by a policy (GPO/Intune), or you launched the installer with PowerShell 7. Use `Install.cmd` |
| Terminal profile missing | Update Windows Terminal (fragments need 1.11+), then restart it |

Built for Windows 11 22H2 and later. Windows 10 mostly works, but the Windows 11 look (rounded corners, Mica) won't apply.

---

## License

MIT, same as the rest of this repository.
