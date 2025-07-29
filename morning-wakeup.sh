#!/bin/bash
set -e

BULB_IPS="192.168.0.97 192.168.0.98"

echo "Stage 1"
bulb-set $BULB_IPS --brightness 10 --temp 3000
sleep 900

echo "Stage 2"
bulb-set $BULB_IPS --brightness 50 --temp 4000
sleep 900

echo "Stage 3"
bulb-set $BULB_IPS --brightness 100 --temp 5000

export DISPLAY=:0
export XAUTHORITY=/home/benjamin/.Xauthority
/usr/bin/xset dpms force on
/usr/bin/openrgb --device 0 --color 0044FF
