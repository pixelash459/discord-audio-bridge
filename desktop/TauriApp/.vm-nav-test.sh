#!/usr/bin/env bash
# Navigation diagnostic: attach to running bridge, log URL transitions, screenshot the window.
set -u
cd "$HOME/Desktop/testing/discord-audio-bridge"
pkill -f discord-audio-bridge-app 2>/dev/null; sleep 1
export DISPLAY=:0
nohup ./desktop/TauriApp/src-tauri/target/release/discord-audio-bridge-app > /tmp/app-nav.log 2>&1 &
sleep 12
echo "=== URL TRANSITIONS ==="
grep -E "window url|navigate" /tmp/app-nav.log || echo "(none logged)"
echo "=== PROCESSES ==="
pgrep -a -f discord-audio-bridge-app | grep -v "bash -c" || echo "app not running"
pgrep -a node | head -2
echo "=== SCREENSHOT ==="
if command -v scrot >/dev/null; then
  scrot -o /tmp/nav-shot.png && echo "scrot ok"
else
  echo "scrot missing"
fi
ls -la /tmp/nav-shot.png 2>/dev/null
