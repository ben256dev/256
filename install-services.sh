#!/bin/bash
set -e

echo "Installing Aliases"
sudo cp .env /etc/256.env

echo "Installing bulb-set /usr/local/bin"
sudo ln -sf "$(pwd)/bulb-set.py" /usr/local/bin/bulb-set

echo "Copying .service and .timer units..."
sudo cp sleep-monitor.{service,timer} wakeup-monitor.{service,timer} /etc/systemd/system/

echo "Reloading systemd..."
sudo systemctl daemon-reexec
sudo systemctl daemon-reload

echo "Enabling timers (but not starting them)..."
sudo systemctl enable sleep-monitor.timer
sudo systemctl enable wakeup-monitor.timer

echo "Done. Timers will start at next scheduled run."

