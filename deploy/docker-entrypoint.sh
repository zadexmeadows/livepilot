#!/bin/sh
set -eu

if [ -z "${VNC_PASSWORD:-}" ]; then
  echo "VNC_PASSWORD must be configured." >&2
  exit 1
fi

mkdir -p /app/data/browser-profiles /run/livepilot-vnc
chmod 0700 /app/data/browser-profiles /run/livepilot-vnc

x11vnc -storepasswd "$VNC_PASSWORD" /run/livepilot-vnc/passwd >/dev/null

Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -ac &
sleep 1
fluxbox -display :99 >/tmp/fluxbox.log 2>&1 &
x11vnc -display :99 -rfbport 5900 -rfbauth /run/livepilot-vnc/passwd \
  -listen 127.0.0.1 -forever -shared -noxdamage >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc/ 6080 127.0.0.1:5900 >/tmp/novnc.log 2>&1 &

node scripts/init-db.mjs

exec node_modules/.bin/next start --hostname 0.0.0.0 --port 3000
