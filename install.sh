#!/bin/bash
set -e

echo "Installing Aliases"
sudo cp .env /etc/256.env

echo "Installing bulb-set /usr/local/bin"
sudo ln -sf "$(pwd)/bulb-set.py" /usr/local/bin/bulb-set

echo "Copying .service and .timer units..."
sudo cp bedtime.{service,timer} morning.{service,timer} /etc/systemd/system/

echo "Reloading systemd..."
sudo systemctl daemon-reexec
sudo systemctl daemon-reload

echo "Enabling and starting timers..."
sudo systemctl enable bedtime.timer
sudo systemctl enable morning.timer

sudo systemctl start bedtime.timer
sudo systemctl start morning.timer

echo "Done. Timers will start at next scheduled run."

