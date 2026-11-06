#!/bin/bash
set -e

log() {
    systemd-cat -t bulb-routine echo "$@"
}

log "morning-wakeup.sh: $(date)"

log "bulb-set bedroom -b 5 -t 2500"
bulb-set bedroom -b 5 -t 2500
sleep 900

log "bulb-set bedroom -b 25 -t 3000"
bulb-set bedroom -b 25 -t 3000
sleep 900

log "bulb-set bedroom office -b 100 -t 5000"
bulb-set bedroom office -b 100 -t 5000

log "Turning on RGB"
export DISPLAY=:0
export XAUTHORITY=/home/benjamin/.Xauthority
/usr/bin/xset dpms force on
/usr/bin/openrgb --device 0 --color 0044FF
