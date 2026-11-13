# Prints Codex's latest rate limits (from its newest session logs) as JSON, or nothing.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$dir = Join-Path $HOME ".codex\sessions"
if (-not (Test-Path -LiteralPath $dir)) { exit 0 }
$files = Get-ChildItem -LiteralPath $dir -Recurse -Filter *.jsonl -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 5
foreach ($f in $files) {
  $m = Select-String -LiteralPath $f.FullName -Pattern '"rate_limits":\{' -ErrorAction SilentlyContinue | Select-Object -Last 1
  if (-not $m) { continue }
  try {
    $o = $m.Line | ConvertFrom-Json
    $rl = $o.payload.rate_limits
    if ($rl) {
      @{ primary = $rl.primary; secondary = $rl.secondary; credits = $rl.credits; updated_at = [int][double]::Parse(([DateTimeOffset]$f.LastWriteTime).ToUnixTimeSeconds()) } |
        ConvertTo-Json -Depth 5 -Compress
      exit 0
    }
  } catch { continue }
}
