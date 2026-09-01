#!/bin/sh
set -eu

candidate_file=/tmp/Caddyfile.livepilot
active_file=/opt/ytmonitor/Caddyfile
backup_file=/opt/ytmonitor/Caddyfile.pre-livepilot-20260829

if [ ! -f "$candidate_file" ]; then
  echo "Validated candidate Caddyfile is missing." >&2
  exit 1
fi

if grep -q '__LIVEPILOT_PASSWORD_HASH__' "$candidate_file"; then
  echo "Candidate Caddyfile still contains an unresolved placeholder." >&2
  exit 1
fi

sudo cp -p "$active_file" "$backup_file"
sudo cp "$candidate_file" "$active_file"

if ! docker exec ytmonitor-caddy-1 caddy validate --config /etc/caddy/Caddyfile; then
  sudo cp "$backup_file" "$active_file"
  exit 1
fi

if ! docker exec ytmonitor-caddy-1 caddy reload --config /etc/caddy/Caddyfile; then
  sudo cp "$backup_file" "$active_file"
  docker exec ytmonitor-caddy-1 caddy reload --config /etc/caddy/Caddyfile
  exit 1
fi

echo "Caddy routes installed and reloaded."
