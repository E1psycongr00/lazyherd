# Prints Codex's latest rate limits as JSON, or nothing.
# With a path, reads only that session log; without one, the newest few under ~/.codex/sessions.
# Session logs grow to tens of MB, so each is read from the end, a growing chunk at a time.
param([string]$Path)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Find-Limits([string]$file) {
  $fs = $null
  try {
    $fs = [System.IO.File]::Open($file, 'Open', 'Read', 'ReadWrite, Delete')
    $len = $fs.Length
    foreach ($size in 1MB, 8MB, 64MB) {
      $n = [Math]::Min($size, $len)
      $buf = [byte[]]::new($n)
      $fs.Seek($len - $n, 'Begin') | Out-Null
      $read = 0
      while ($read -lt $n) { $r = $fs.Read($buf, $read, $n - $read); if ($r -le 0) { break }; $read += $r }
      $lines = [System.Text.Encoding]::UTF8.GetString($buf, 0, $read) -split "`n"
      # The first line is cut off unless the chunk starts at the beginning of the file.
      $first = if ($n -lt $len) { 1 } else { 0 }
      for ($i = $lines.Count - 1; $i -ge $first; $i--) {
        if ($lines[$i] -notmatch '"rate_limits":\{') { continue }
        try {
          $o = $lines[$i] | ConvertFrom-Json
          $rl = $o.payload.rate_limits
          if (-not $rl) { continue }
          $at = if ($o.timestamp) { [DateTimeOffset]::Parse($o.timestamp).ToUnixTimeSeconds() }
                else { ([DateTimeOffset](Get-Item -LiteralPath $file).LastWriteTime).ToUnixTimeSeconds() }
          return @{ primary = $rl.primary; secondary = $rl.secondary; credits = $rl.credits; updated_at = [long]$at }
        } catch { continue }
      }
      if ($n -ge $len) { break }
    }
  } catch {} finally { if ($fs) { $fs.Dispose() } }
  return $null
}

$files = if ($Path) { @($Path) } else {
  $dir = Join-Path $HOME ".codex\sessions"
  if (-not (Test-Path -LiteralPath $dir)) { exit 0 }
  Get-ChildItem -LiteralPath $dir -Recurse -Filter *.jsonl -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 5 | ForEach-Object FullName
}
foreach ($f in $files) {
  $j = Find-Limits $f
  if ($j) { $j | ConvertTo-Json -Depth 5 -Compress; exit 0 }
}
