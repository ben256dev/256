#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

mkdir -p logs
chmod +x make_thumbs.sh
chmod +x obs_fingerprint.sh

if ! command -v ffmpeg >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y ffmpeg
fi

# Start / restart PM2 processes
pm2 start ecosystem.config.js || true
pm2 restart obs_server || true
pm2 restart make_thumbs || true
pm2 restart obs_fingerprint || true
pm2 save

