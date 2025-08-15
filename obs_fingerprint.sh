#!/usr/bin/env bash
set -euo pipefail

src="${1:-$HOME/obs_output}"
dst="$src/.sht"

mkdir -p "$dst"

find "$src" -path "$dst" -prune -o -type f -print0 | while IFS= read -r -d '' f; do
    name="${f##*/}"
    if [ ! -f "$dst/$name" ]; then
        echo "$name"
        sht < "$f" > "$dst/$name"
    fi
done

cat "$dst"/* | sht

