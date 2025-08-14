#!/bin/bash
set -e

log() {
    systemd-cat -t bulb-routine echo "$@"
}

log "bedtime-mode.sh: $(date)"

log "bulb-set $BULB_OFFICE $BULB_BEDROOM --brightness 50 --temp 2700"
bulb-set $BULB_OFFICE $BULB_BEDROOM --brightness 50 --temp 2700
sleep 3600  # 1 hour

log "bulb-set $BULB_OFFICE $BULB_BEDROOM --brightness 60 --color ffaa00"
bulb-set $BULB_OFFICE $BULB_BEDROOM --brightness 60 --color ffaa00
sleep 2700  # 45 minutes

log "bulb-set $BULB_OFFICE $BULB_BEDROOM --brightness 45 --color ffaa00"
bulb-set $BULB_OFFICE $BULB_BEDROOM --brightness 45 --color ffaa00
sleep 900   # 15 minutes

log "Turning off RGB"
export DISPLAY=:0
export XAUTHORITY=/home/benjamin/.Xauthority
/usr/bin/xset dpms force off
/usr/bin/openrgb --device 0 --color 000000

log "bulb-set $BULB_OFFICE $BULB_BEDROOM --off"
bulb-set $BULB_OFFICE $BULB_BEDROOM --off

