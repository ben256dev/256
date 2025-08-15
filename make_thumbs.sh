#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-.}"
LOG_FILE="${2:-/dev/null}"

THUMB_TIME="${THUMB_TIME:-00:00:03}"
REMUX_DELETE_MKV="${REMUX_DELETE_MKV:-0}"
REMUX_STILL_WRITING_MARGIN_SEC="${REMUX_STILL_WRITING_MARGIN_SEC:-60}"

root_abs="$(readlink -f "$ROOT")"
now_ts="$(date +%s)"

find "$root_abs" -type f -iname '*.mkv' | while IFS= read -r mkv; do
    mtime="$(stat -c %Y "$mkv" || echo 0)"
    age="$(( now_ts - mtime ))"
    if [ "$age" -lt "$REMUX_STILL_WRITING_MARGIN_SEC" ]; then
        echo "skip-remux-recent: $mkv" | tee -a "$LOG_FILE"
        continue
    fi
    dir="$(dirname "$mkv")"
    base="$(basename "$mkv")"
    name="${base%.*}"
    mp4="$dir/$name.mp4"
    if [ -f "$mp4" ]; then
        echo "skip-remux-exists: $mp4" | tee -a "$LOG_FILE"
    else
        echo "remux: $mkv -> $mp4" | tee -a "$LOG_FILE"
        if ffmpeg -y -i "$mkv" -c copy -movflags +faststart "$mp4" >>"$LOG_FILE" 2>&1; then
            if [ "$REMUX_DELETE_MKV" = "1" ]; then
                rm -f "$mkv"
                echo "remux-cleanup: removed $mkv" | tee -a "$LOG_FILE"
            else
                bakdir="$dir/.mkv_originals"
                mkdir -p "$bakdir"
                mv -f "$mkv" "$bakdir/$base"
                echo "remux-backup: $mkv -> $bakdir/$base" | tee -a "$LOG_FILE"
            fi
        else
            echo "remux-fail: $mkv" | tee -a "$LOG_FILE"
        fi
    fi
done

find "$root_abs" -type f -iname '*.mp4' | while IFS= read -r video; do
    dir="$(dirname "$video")"
    base="$(basename "$video")"
    name="${base%.*}"
    jpg="$dir/$name.jpg"
    if [ -f "$jpg" ]; then
        echo "skip-thumb: $jpg" | tee -a "$LOG_FILE"
    else
        echo "thumb: $video -> $jpg" | tee -a "$LOG_FILE"
        ffmpeg -y -ss "$THUMB_TIME" -i "$video" -vframes 1 -q:v 2 "$jpg" >>"$LOG_FILE" 2>&1 || echo "thumb-fail: $video" | tee -a "$LOG_FILE"
    fi
done

