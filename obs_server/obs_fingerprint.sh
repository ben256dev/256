#!/usr/bin/env bash
set -euo pipefail

src="${1:-$HOME/obs_output}"
dst="$src/.sht"
tmp="$src/.sht.tmp.$$"

if [ "${OBS_REBUILD_FINGERPRINT:-0}" != "1" ] && [ -d "$dst" ] && find "$dst" -type f -print -quit | grep -q .; then
    set +o pipefail
    cat "$dst"/* | sht
    exit 0
fi

rm -rf "$tmp"
mkdir -p "$tmp"

find "$src" -type d -name '.*' -prune -o -type f -print0 | while IFS= read -r -d '' f; do
    name="${f##*/}"
    if [ ! -f "$tmp/$name" ]; then
        echo "$name"
        sht < "$f" > "$tmp/$name"
    fi
done

rm -rf "$dst"
mv "$tmp" "$dst"

set +o pipefail
cat "$dst"/* | sht
