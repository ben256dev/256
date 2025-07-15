#!/bin/bash
export DISPLAY=:0
export XAUTHORITY=/home/benjamin/.Xauthority
xset dpms force on
openrgb --device 0 --color 0044FF
