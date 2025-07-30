#!/bin/bash
set -e

set -a
source /etc/256.env
set +a

bulb-set $BULB_OFFICE $BULB_BEDROOM --brightness 50 --temp 2700
sleep 3600  # 1 hour

bulb-set $BULB_OFFICE $BULB_BEDROOM --brightness 60 --color ffaa00
sleep 2700  # 45 minutes

bulb-set $BULB_OFFICE $BULB_BEDROOM --brightness 45 --color ffaa00
sleep 900   # 15 minutes

export DISPLAY=:0
export XAUTHORITY=/home/benjamin/.Xauthority
/usr/bin/xset dpms force off
/usr/bin/openrgb --device 0 --color 000000

bulb-set $BULB_OFFICE $BULB_BEDROOM --off
