#!/usr/bin/env bash
# reapply-acp-window-patch.sh — 手工等价物 (macOS / Linux)
set -u
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1
OLD='bodyProvablyOverWindow2(body,init,effectiveContextWindow(ctx))'
NEW='bodyProvablyOverWindow2(body,init,effectiveContextWindow(ctx)??MIN_ASSUMED_WINDOW_TOKENS)'
found=0
for f in "$HOME"/.dsh/profiles/*/node_modules/billion-context/dist/agent/dsh-native.js; do
  [ -f "$f" ] || continue
  found=1
  raw=$(grep -o -F "$OLD" "$f" | wc -l | tr -d ' ')
  already=$(grep -o -F "$NEW" "$f" | wc -l | tr -d ' ')
  if [ "$raw" -eq 0 ] && [ "$already" -ge 2 ]; then echo "ALREADY PATCHED (call sites=$already) $f"; continue; fi
  if [ "$raw" -eq 0 ]; then echo "PATTERN NOT FOUND $f"; exit 3; fi
  if [ "$CHECK" -eq 1 ]; then echo "WOULD PATCH $raw site(s) $f"; continue; fi
  bak="$f.bak-window-guard-$(date +%Y%m%d-%H%M%S)"
  cp "$f" "$bak"
  perl -0pi -e "s/\Q$OLD\E/$NEW/g" "$f"
  echo "PATCHED $raw site(s) $f (backup: $(basename "$bak"))"
done
[ "$found" -eq 0 ] && { echo "NO ACP BUNDLE FOUND"; exit 3; }
exit 0