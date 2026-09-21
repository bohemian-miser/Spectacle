#!/usr/bin/env bash
# Compute Engine startup script: runs as root on every boot. Idempotent.
# Installs Docker, adds swap (an e2-micro has 1 GB), checks out the deploy
# files and brings the stack up. Later boots just refresh the files and
# restart whatever is not running.
set -euo pipefail

REPO="${SPECTACLE_REPO:-https://github.com/bohemian-miser/Spectacle.git}"
BRANCH="${SPECTACLE_BRANCH:-main}"
APP=/opt/spectacle

if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ca-certificates curl git
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi

if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if [ ! -d "$APP/repo/.git" ]; then
  mkdir -p "$APP"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP/repo"
else
  git -C "$APP/repo" fetch --depth 1 origin "$BRANCH"
  git -C "$APP/repo" reset --hard "origin/$BRANCH"
fi

cp "$APP/repo/deploy/gcp/docker-compose.yml" "$APP/docker-compose.yml"
cp "$APP/repo/deploy/gcp/Caddyfile" "$APP/Caddyfile"
[ -f "$APP/.env" ] || cp "$APP/repo/deploy/gcp/env.example" "$APP/.env"

# Optional: a domain from instance metadata turns on HTTPS.
DOMAIN=$(curl -sf -H 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/attributes/spectacle-domain' || true)
if [ -n "$DOMAIN" ]; then
  echo "SITE_ADDRESS=$DOMAIN" > "$APP/.compose.env"
else
  echo "SITE_ADDRESS=:80" > "$APP/.compose.env"
fi

cd "$APP"
docker compose --env-file .compose.env pull
docker compose --env-file .compose.env up -d --remove-orphans
