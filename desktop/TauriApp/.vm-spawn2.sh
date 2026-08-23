#!/usr/bin/env bash
# Fresh-user scenario: no bridge anywhere. Shell must spawn one, load the panel, and reap it.
set -u
cd "$HOME/Desktop/testing/discord-audio-bridge"
pkill -f discord-audio-bridge-app 2>/dev/null
for p in $(pgrep -f "usr/lib/discord-audio-bridge"); do kill "$p" 2>/dev/null; done
for p in $(pgrep -f "src/index.ts"); do [ "$p" -ne "$$" ] && kill "$p" 2>/dev/null; done
sleep 2
rm -f .control-token "$HOME/.local/state/discord-audio-bridge/.control-token"
echo "node procs before: $(pgrep -c node || echo 0)"

export DISPLAY=:0
unset BRIDGE_RUNTIME_ROOT
nohup ./desktop/TauriApp/src-tauri/target/release/discord-audio-bridge-app > /tmp/app-spawn2.log 2>&1 &
sleep 25

echo "=== URL TRANSITIONS ==="
grep -E "window url" /tmp/app-spawn2.log || echo "(none)"
echo "=== PROCESSES ==="
pgrep -a -f discord-audio-bridge-app | grep -v "bash -c" || echo "app not running"
pgrep -a node | head -3 || echo "no node"
echo "=== SCREENSHOT ==="
scrot -o /tmp/spawn2-shot.png && ls -la /tmp/spawn2-shot.png

echo "=== QUIT VIA SIGTERM, CHECK REAP ==="
APP=$(pgrep -f "TauriApp/src-tauri/target/release" | head -1)
kill "$APP"; sleep 3
pgrep -f "src/index.ts" > /dev/null && echo "ORPHAN - FAIL" || echo "reaped - PASS"

echo "=== RESTORE SYSTEM BRIDGE ==="
nohup /usr/lib/discord-audio-bridge/discord-audio-bridge --open > /tmp/system-bridge.log 2>&1 &
sleep 4
pgrep -a node | head -2
