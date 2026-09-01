#!/bin/sh
set -eu

deployment_directory=/opt/livepilot/deploy
credentials_file="$deployment_directory/access-credentials.txt"
template_file="$deployment_directory/Caddyfile.public.template"
candidate_file=/tmp/Caddyfile.livepilot

umask 077

if [ ! -f "$credentials_file" ]; then
  printf 'USERNAME=livepilot\nPASSWORD=' > "$credentials_file"
  openssl rand -hex 12 >> "$credentials_file"
fi

password=$(sed -n 's/^PASSWORD=//p' "$credentials_file")
password_hash=$(docker exec ytmonitor-caddy-1 caddy hash-password --plaintext "$password")

sed "s|__LIVEPILOT_PASSWORD_HASH__|$password_hash|g" "$template_file" > "$candidate_file"
chmod 0600 "$candidate_file"

docker run --rm \
  -v "$candidate_file:/etc/caddy/Caddyfile:ro,Z" \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile

echo "$candidate_file"
