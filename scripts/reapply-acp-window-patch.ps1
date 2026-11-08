<#
  reapply-acp-window-patch.ps1 — 手工等价物（不装插件时用）
  幂等：已打补丁则输出 ALREADY PATCHED 并以 0 退出。
#>
param([switch]$CheckOnly)

$patterns = @(
  (Join-Path $HOME '.dsh/profiles/*/node_modules/billion-context/dist/agent/dsh-native.js')
)
$OLD = 'bodyProvablyOverWindow2(body,init,effectiveContextWindow(ctx))'
$NEW = 'bodyProvablyOverWindow2(body,init,effectiveContextWindow(ctx)??MIN_ASSUMED_WINDOW_TOKENS)'

$files = @()
foreach ($p in $patterns) { $files += Get-ChildItem -Path $p -ErrorAction SilentlyContinue }
if ($files.Count -eq 0) { Write-Output "NO ACP BUNDLE FOUND"; exit 3 }

foreach ($f in $files) {
  $text = [System.IO.File]::ReadAllText($f.FullName)
  $raw = ([regex]::Matches($text, [regex]::Escape($OLD))).Count
  $already = ([regex]::Matches($text, [regex]::Escape($NEW))).Count
  if ($raw -eq 0 -and $already -ge 2) { Write-Output "ALREADY PATCHED (call sites=$already) $($f.FullName)"; continue }
  if ($raw -eq 0) { Write-Output "PATTERN NOT FOUND $($f.FullName)"; exit 3 }
  if ($CheckOnly) { Write-Output "WOULD PATCH $raw site(s) $($f.FullName)"; continue }
  $bak = "$($f.FullName).bak-window-guard-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Copy-Item $f.FullName $bak -Force
  [System.IO.File]::WriteAllText($f.FullName, $text.Replace($OLD, $NEW), (New-Object System.Text.UTF8Encoding($false)))
  Write-Output "PATCHED $raw site(s) $($f.FullName) (backup: $(Split-Path $bak -Leaf))"
}
exit 0