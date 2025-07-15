#!/bin/bash
export DISPLAY=:0
export XAUTHORITY=/home/benjamin/.Xauthority
xset dpms force off
openrgb --device 0 --color 000000
