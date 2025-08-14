#!/bin/bash
src=~/obs_output
dst="$src/.sht"

mkdir -p "$dst"

for f in "$src"/*; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    if [ ! -f "$dst/$name" ]; then
        echo "$name"
        sht < "$f" > "$dst/$name"
    fi
done

cat "$dst"/* | sht
