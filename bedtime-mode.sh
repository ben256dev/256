#!/bin/bash
set -e

BULB_IPS="192.168.0.97 192.168.0.98"

echo "Stage 1: 2 hours before bed — 50% @ 2700K"
bulb-set $BULB_IPS --brightness 50 --temp 2700
sleep 3600  # 1 hour

echo "Stage 2: 1 hour before bed — 30%"
bulb-set $BULB_IPS --brightness 60 --color ffaa00
sleep 2700  # 45 minutes

echo "Stage 3: 15 minutes before sleep — 10%"
bulb-set $BULB_IPS --brightness 45 --color ffaa00
sleep 900   # 15 minutes

echo "Stage 4: Lights out"
export DISPLAY=:0
export XAUTHORITY=/home/benjamin/.Xauthority
/usr/bin/xset dpms force off
/usr/bin/openrgb --device 0 --color 000000

bulb-set $BULB_IPS --off
