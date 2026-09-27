'use strict';
// The one-time, per-laptop setup, as a PowerShell snippet the website shows with a copy
// button. It does what the desktop app's SHARE SESSIONS ON THIS DRIVE button does:
//   1. copy this laptop's existing Claude Code sessions to the drive (newer files win)
//   2. keep the original folder as a backup
//   3. turn %USERPROFILE%\.claude\projects into a junction to the drive (no admin needed)
//   4. keep sessions 10 years instead of 30 days (cleanupPeriodDays)
// Wrapped in & { } so a pasted copy runs as one block and stops at the first problem.
// Running it twice is safe: the second time it reports "Already set up".
// Works in Windows PowerShell 5.1 and PowerShell 7 (tested on a Windows runner in CI).

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** @param target  e.g. E:\claude-sessions   @param claudeDir  default: $env:USERPROFILE\.claude */
function setupScript(target, { claudeDir = null } = {}) {
  const claude = claudeDir ? psQuote(claudeDir) : '(Join-Path $env:USERPROFILE ".claude")';
  return ['& {',
    `$claude = ${claude}; $drive = ${psQuote(target)}; $p = Join-Path $claude "projects"; $backup = $null`,
    'if (-not (Test-Path (Split-Path $drive -Qualifier))) { Write-Host "Drive $(Split-Path $drive -Qualifier) not found. Plug it in and try again." -ForegroundColor Red; return }',
    'New-Item -ItemType Directory -Force -Path $drive | Out-Null',
    '$item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue',
    'if ($item -and $item.LinkType) { Write-Host "Already set up: $p -> $($item.Target)" -ForegroundColor Green }',
    'else {',
    '  if ($item) {',
    // /COPY:DT /FFT: data + times only, 2-second time tolerance, so exFAT/FAT32 drives work
    '    $out = robocopy $p $drive /E /XO /XJ /FFT /COPY:DT /R:2 /W:2 /NFL /NDL /NJH /NJS /NP',
    '    if ($LASTEXITCODE -ge 8) {',
    '      Write-Host "Some files could not be copied (robocopy $LASTEXITCODE). Nothing was changed on this laptop." -ForegroundColor Red',
    '      $out | Select-String "ERROR" -Context 0,1 | Select-Object -First 4 | ForEach-Object { Write-Host $_.Line.Trim() -ForegroundColor Yellow; if ($_.Context.PostContext) { Write-Host ("  " + $_.Context.PostContext[0].Trim()) } }',
    '      Write-Host "Usually a Claude app still has a file open: close Claude Code, VS Code and the Claude desktop app (or run: Stop-Process -Name claude -Force), then run this again."',
    '      return',
    '    }',
    '    $backup = "$p.before-engram-$(Get-Date -Format yyyyMMdd-HHmmss)"',
    '    try { Rename-Item -LiteralPath $p -NewName (Split-Path $backup -Leaf) -ErrorAction Stop } catch { Write-Host "Claude Code seems to be running. Close it and try again." -ForegroundColor Red; return }',
    '  }',
    '  New-Item -ItemType Directory -Force -Path $claude | Out-Null',
    '  New-Item -ItemType Junction -Path $p -Target $drive | Out-Null',
    '  Write-Host "Done: Claude Code sessions now live on $drive" -ForegroundColor Green',
    '  if ($backup) { Write-Host "Your original folder is kept at $backup" }',
    '}',
    '$s = Join-Path $claude "settings.json"',
    'try { $j = if (Test-Path $s) { Get-Content $s -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }',
    '  if (-not $j.cleanupPeriodDays -or $j.cleanupPeriodDays -lt 3650) { $j | Add-Member -Force -NotePropertyName cleanupPeriodDays -NotePropertyValue 3650; $j | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $s -Encoding UTF8 } }',
    'catch { Write-Host "Could not update settings.json (sessions still shared): $_" -ForegroundColor Yellow }',
    '}'].join('\n');
}

/** Undo on one laptop: remove the junction, restore a normal folder with copies from the drive. */
function undoScript(target, { claudeDir = null } = {}) {
  const claude = claudeDir ? psQuote(claudeDir) : '(Join-Path $env:USERPROFILE ".claude")';
  return ['& {',
    `$claude = ${claude}; $drive = ${psQuote(target)}; $p = Join-Path $claude "projects"`,
    '$item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue',
    'if (-not ($item -and $item.LinkType)) { Write-Host "Not linked to the drive; nothing to undo." ; return }',
    '[System.IO.Directory]::Delete($p)  # removes only the link, never the drive folder',
    'New-Item -ItemType Directory -Path $p | Out-Null',
    'if (Test-Path $drive) { robocopy $drive $p /E /XO /XJ /FFT /COPY:DT /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null }',
    'Write-Host "Done: this laptop has a normal sessions folder again (with copies from the drive)." -ForegroundColor Green',
    '}'].join('\n');
}

module.exports = { setupScript, undoScript, psQuote };
