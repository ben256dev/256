#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

mkdir -p logs
chmod +x make_thumbs.sh

if ! command -v ffmpeg >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y ffmpeg
fi

pm2 start obs_server.config.js || true
pm2 restart obs_server || true
pm2 restart make_thumbs || true
pm2 save

