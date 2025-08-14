#!/bin/bash
set -e

log() {
    systemd-cat -t bulb-routine echo "$@"
}

log "morning-wakeup.sh: $(date)"

log "bulb-set $BULB_BEDROOM --brightness 5 --temp 2500"
bulb-set $BULB_BEDROOM --brightness 5 --temp 2500
sleep 900

log "bulb-set $BULB_BEDROOM --brightness 25 --temp 3000"
bulb-set $BULB_BEDROOM --brightness 25 --temp 3000
sleep 900

log "bulb-set $BULB_BEDROOM $BULB_OFFICE --brightness 100 --temp 5000"
bulb-set $BULB_BEDROOM $BULB_OFFICE --brightness 100 --temp 5000

log "Turning on RGB"
export DISPLAY=:0
export XAUTHORITY=/home/benjamin/.Xauthority
/usr/bin/xset dpms force on
/usr/bin/openrgb --device 0 --color 0044FF

