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
    // Room check first: "not enough space" (robocopy error 112) otherwise shows up mid-copy.
    '    $files = Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue',
    '    $need = ($files | Measure-Object Length -Sum).Sum; if (-not $need) { $need = 0 }',
    '    $vol = try { Get-Volume -DriveLetter (Split-Path $drive -Qualifier).TrimEnd(":") -ErrorAction Stop } catch { $null }',
    '    if ($vol -and $vol.SizeRemaining -lt $need) { Write-Host ("Not enough space on {0} {1:N1} GB needed, {2:N1} GB free. Free up space or use a bigger drive, then run this again. Nothing was changed." -f (Split-Path $drive -Qualifier), ($need/1GB), ($vol.SizeRemaining/1GB)) -ForegroundColor Red; return }',
    '    $big = $files | Where-Object { $_.Length -ge 4GB } | Select-Object -First 1',
    '    if ($vol -and $vol.FileSystem -eq "FAT32" -and $big) { Write-Host ("{0} is FAT32, which cannot hold files over 4 GB ({1}). Reformat the drive as exFAT (copy your files off first), then run this again. Nothing was changed." -f (Split-Path $drive -Qualifier), $big.Name) -ForegroundColor Red; return }',
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

/**
 * Resume one conversation on this laptop, whatever the project's folder is called here.
 * Claude Code only lists a conversation under the folder it was started in, so this finds the
 * newest copy of the conversation (this laptop's Claude folder, or <any drive>\claude-sessions),
 * puts it under the folder the terminal is in (or the original project folder when it exists
 * here), and opens it. The newest copy always wins, so going back and forth between laptops and
 * folders keeps the whole conversation.
 */
function resumeScript({ id, projectPath = null } = {}) {
  if (!/^[A-Za-z0-9-]+$/.test(String(id || ''))) throw new Error('bad session id');
  return ['& {',
    `$id = ${psQuote(id)}`,
    projectPath ? `if (Test-Path -LiteralPath ${psQuote(projectPath)}) { Set-Location -LiteralPath ${psQuote(projectPath)} }` : null,
    '$mine = Join-Path $env:USERPROFILE ".claude\\projects"',
    '$roots = @($mine) + (Get-PSDrive -PSProvider FileSystem | ForEach-Object { Join-Path $_.Root "claude-sessions" }) | Where-Object { Test-Path -LiteralPath $_ }',
    '$src = $roots | ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter "$id.jsonl" -Recurse -Depth 1 -File -ErrorAction SilentlyContinue } | Sort-Object LastWriteTime -Descending | Select-Object -First 1',
    'if (-not $src) { Write-Host "Could not find this conversation. Plug in the drive and try again." -ForegroundColor Red; return }',
    '$dst = Join-Path $mine ((Get-Location).Path -replace "[^A-Za-z0-9]", "-")',
    'New-Item -ItemType Directory -Force -Path $dst | Out-Null',
    '$to = Join-Path $dst "$id.jsonl"',
    'if ($src.FullName -ne $to -and (-not (Test-Path -LiteralPath $to) -or (Get-Item -LiteralPath $to).LastWriteTime -lt $src.LastWriteTime)) { Copy-Item -LiteralPath $src.FullName -Destination $to -Force }',
    'Write-Host "Resuming in $((Get-Location).Path)" -ForegroundColor Green',
    'claude --resume $id',
    '}'].filter(Boolean).join('\n');
}

module.exports = { setupScript, undoScript, resumeScript, psQuote };
