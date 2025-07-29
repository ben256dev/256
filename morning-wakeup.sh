#!/bin/bash
set -e

source /etc/256.env

bulb-set $BULB_BEDROOM --brightness 5 --temp 2200
sleep 900

bulb-set $BULB_BEDROOM --brightness 25 --temp 3000
sleep 900

bulb-set $BULB_BEDROOM $BULB_OFFICE --brightness 100 --temp 5000

export DISPLAY=:0
export XAUTHORITY=/home/benjamin/.Xauthority
/usr/bin/xset dpms force on
/usr/bin/openrgb --device 0 --color 0044FF
