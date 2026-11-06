#!/bin/bash
set -e

log() {
    systemd-cat -t bulb-routine echo "$@"
}

log "bedtime-mode.sh: $(date)"

log "bulb-set office bedroom -b 50 -t 2700"
bulb-set office bedroom -b 50 -t 2700
sleep 3600  # 1 hour

log "bulb-set office bedroom -b 60 --color ffaa00"
bulb-set office bedroom -b 60 --color ffaa00
sleep 2700  # 45 minutes

log "bulb-set office bedroom -b 45 --color ffaa00"
bulb-set office bedroom -b 45 --color ffaa00
sleep 900   # 15 minutes

log "Turning off RGB"
export DISPLAY=:0
export XAUTHORITY=/home/benjamin/.Xauthority
/usr/bin/xset dpms force off
/usr/bin/openrgb --device 0 --color 000000

log "bulb-set office bedroom --off"
bulb-set office bedroom --off
