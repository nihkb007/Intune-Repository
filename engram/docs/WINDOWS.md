# ENGRAM on Windows: setup guide

## 1. Pick a version

| | **Portable (recommended)** | Installer |
| --- | --- | --- |
| File | `ENGRAM-Portable-1.0.0-win-x64.zip` | `ENGRAM-Setup-1.0.0.exe` |
| Install needed | No. Extract and run | Yes. Setup wizard |
| Admin rights | No | No (installs for your user only) |
| Where your data lives | `ENGRAM\ENGRAM-data\`, next to the exe | `%APPDATA%\ENGRAM\` |
| Start Menu / desktop shortcut | Make your own (optional) | Created for you |
| Remove it | Delete the folder | Settings → Apps → ENGRAM → Uninstall |

The two versions run the same app. Portable keeps everything in one folder, so you can
back it up, move it, or run it from a USB stick.

## 2. Download

Go to the repository on GitHub → **Releases** → **ENGRAM (latest Windows build)**
(tag `engram-latest`), and download the zip or the exe.
`SHA256SUMS.txt` on the same page lists checksums you can use to verify the download.

If the release isn't there yet, go to **Actions → ENGRAM build**, open the latest green
run, and download the **ENGRAM-windows** artifact. It's a zip that contains both files.

**Optional: verify the download.** Run this in PowerShell and check that the hash
matches the line in `SHA256SUMS.txt`:

```powershell
Get-FileHash "$HOME\Downloads\ENGRAM-Portable-1.0.0-win-x64.zip" -Algorithm SHA256
```

## 3a. Portable setup

1. **Unblock the zip before extracting it.** Right-click the zip → **Properties** → tick
   **Unblock** (bottom of the General tab) → **OK**. Windows then won't flag every file
   inside as "from the internet". You can do the same in PowerShell:
   ```powershell
   Unblock-File "$HOME\Downloads\ENGRAM-Portable-1.0.0-win-x64.zip"
   ```
2. Extract it to a permanent spot, for example `C:\Tools\`. You'll get `C:\Tools\ENGRAM\`.
   - Keep the folder out of `Downloads` and `Temp`.
   - Keep the `ENGRAM-data` folder next to `ENGRAM.exe`. That folder turns portable mode
     on. If you delete it, ENGRAM falls back to `%APPDATA%\ENGRAM`.
3. Double-click `ENGRAM.exe`.
4. Optional shortcut: right-click `ENGRAM.exe` → **Show more options** → **Send to** →
   **Desktop (create shortcut)**. To pin it, right-click the shortcut → **Pin to Start**.

To check that portable mode is on, open **SYSTEM** in ENGRAM. *Vault location* shows a
green **PORTABLE** tag and a path inside your ENGRAM folder.

## 3b. Installer setup

Run `ENGRAM-Setup-1.0.0.exe`, choose a folder (the default is fine), and finish. ENGRAM
starts when setup finishes, and you'll find it in the Start Menu and on your desktop.

## 4. Windows security prompts

ENGRAM is **not code-signed**. Code signing needs a paid certificate tied to a verified
identity. Here's what to expect:

- **SmartScreen: "Windows protected your PC."** Windows shows this for most new unsigned
  apps. Click **More info** → **Run anyway**. It usually appears only the first time.
  Unblocking the zip first (step 3a.1) normally prevents it for the portable version.
- **Microsoft Defender Antivirus.** ENGRAM is a standard Electron app with no packers,
  obfuscation or network calls, which is the kind of app Defender normally leaves alone.
  The **portable zip is the lowest-risk format**. Single-file self-extracting "portable
  exe" builds are the ones antivirus tools flag more often, so ENGRAM doesn't ship one.
  If Defender ever quarantines it: **Windows Security → Virus & threat protection →
  Protection history**, check the entry, and choose **Restore/Allow** only if the file
  came from your own GitHub release. Don't turn Defender off.
- **Work laptops managed by Intune / Endpoint Manager.** Your organization may block
  unsigned apps with AppLocker or WDAC (App Control for Business), or with Smart App
  Control. If so, ENGRAM won't start no matter what you click. Your IT admin has to
  allow it, for example with a path or hash rule, or by signing it.

**The only way to get rid of every warning** is to code-sign the build. A
low-cost option is Microsoft's **Azure Trusted Signing** (around $10/month). The build
workflow can sign automatically once you have an account.

## 5. Connect your Claude accounts

ENGRAM reads the session files Claude Code saves on your laptop. You need
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed, so the `claude`
command works in PowerShell.

### How your two accounts are stored

- **Account 1** uses the default folder: `C:\Users\<you>\.claude`
- **Account 2** gets its own folder, for example `C:\Users\<you>\.claude-personal`

A separate folder per account lets ENGRAM split costs by account and copy sessions
between them. If you currently switch accounts with `/logout` and `/login` in the same
folder, ENGRAM still works. It will show both accounts' history as a single account.

### One-time setup for account 2

Open PowerShell:

```powershell
$env:CLAUDE_CONFIG_DIR = "$HOME\.claude-personal"
claude
```

Inside Claude, run `/login` and sign in with your **second** account, then exit. This
setting only applies to this PowerShell window, so a normal `claude` still uses account 1.

### Link them in ENGRAM

1. Open ENGRAM → **BRIDGE** → **DETECT**. It finds `.claude` and every `.claude-*`
   folder, and reads the email you're signed in with.
2. Optional: click **EDIT** on each card to rename it (for example "WORK" and
   "PERSONAL") and choose a color.
3. If a folder is somewhere else, use **LINK ACCOUNT** → **BROWSE**.

## 6. Everyday use

| Goal | Where |
| --- | --- |
| See what each project costs | **NEXUS** and **PROJECTS** |
| Switch accounts | The account chips in the top bar, or **SWITCH** in BRIDGE |
| Open Claude on a specific account | **BRIDGE → TERMINAL**, or **LAUNCH CLAUDE** / **LAUNCH HERE** on a project. ENGRAM opens PowerShell with the right account set. |
| Continue an old session on the *other* account | **RECORDINGS** → open the session → **RESUME ON \<account\>**. ENGRAM first copies that session to the account, then runs `claude --resume`. |
| Share all sessions with both accounts | **BRIDGE → SYNC NOW** |
| Record a rule Claude must always follow | **VAULT → NEW ENGRAM**, kind *Directive*. Set scope *Global* for all projects, pin it, then **BRIDGE → SYNC MEMORY** |
| Combine sessions into a short summary | **RECORDINGS** → tick sessions → **FUSE INTO CAPSULE**. Then **INJECT INTO CLAUDE.md** so both accounts load it automatically. |
| Find anything | **Ctrl+K** |
| Refresh | **Ctrl+R**. ENGRAM also refreshes automatically when Claude writes new sessions. |

ENGRAM only writes into your Claude folders when you press **SYNC NOW**, **SYNC MEMORY**,
**INJECT**, or **RESUME ON**. Everything else is read-only.

## 7. Backup, moving and removal

- **Portable:** copy the whole `ENGRAM` folder. That's your entire vault and your
  session archive.
- **Installed:** back up `%APPDATA%\ENGRAM\vault`.
- ENGRAM stores copies of your sessions in its archive. They stay available after Claude
  Code deletes old history, which happens after about 30 days by default.
- On a USB stick, portable ENGRAM reads the Claude folders of **whichever PC it's
  running on**. Your vault and archive go with the stick.

## 8. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Dashboard is empty | BRIDGE → DETECT. Check that `C:\Users\<you>\.claude\projects` exists. You need at least one Claude Code session first. |
| The launched terminal says `claude` is not recognized | Install Claude Code, or reopen the terminal so PATH updates. |
| Costs seem high or low | SYSTEM → pricing table. ENGRAM uses API list prices, so on a Pro/Max plan the numbers show *what the usage would cost at API rates*, not what you are billed. |
| App won't start on a work laptop | Blocked by company policy. See section 4. |
| Start again from scratch | Close ENGRAM and delete `ENGRAM-data` (portable) or `%APPDATA%\ENGRAM` (installed). Your Claude sessions are not affected. |
