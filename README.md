# 256 Home Server

## Improving The Basic Console

We shouldn't be spending much time in this console, but it's important for logging in upon reboot. To make it look nicer we will change the settings to have a colorful prompt and to rotate the terminal to fit my vertical display.

### Rotate Display

```bash
sudo vim /etc/default/grub
# change GRUB_CMDLINE_LINUX_DEFAULT=... to "quiet fbcon=rotate:1"
sudo update-grub
```

### Colorful Prompt

```bash
sudo vim ~/.bashrc
# somewhere at the top of the .bashrc we add: 'export TERM="xterm-256color"'
source .bashrc
```

Reboot for changes to take affect:

```bash
sudo reboot
```

## Minimalist Desktop

Servers are typically headless. Although we disabled a desktop environment in the Debian install, we will be adding some functionality back without enabling a full desktop environment.

```bash
sudo apt install --yes X11-utils xorg xinit X11-xserver-utils xclIP feh picom suckless-tools kitty fzf bspwm sxhkd firefox-esr
```

### bspwm

Edit the bspwm config and replace ``terminal`` with ``kitty``:

```bash
mkdir -p ~/.config/bspwm
cp /usr/share/doc/bspwm/examples/bspwmrc ~/.config/bspwm/bspwmrc
chmod +x ~/.config/bspwm/bspwmrc
vim ~/.config/bspwm/bspwmrc 
#terminal="kitty"
```

### sxhkd

```bash
mkdir -p ~/.config/sxhkd
cp /usr/share/doc/bspwm/examples/sxhkdrc ~/.config/sxhkd/sxhkdrc
```

We also have to change the default terminal here:

```ini
# terminal emulator
super + Return
	kitty
```

The file contains all our other keybinds and will be super useful for future reference.

### X11

We need to make an ``~/.xinitrc`` with the following commands to run at X11 startup:

```bash
#!/bin/sh
xrandr --output HDMI-A-0 --rotate right &
xset s off; xset -dpms; xset s noblank
picom --experimental-backends -b &
(sleep 1 && feh --bg-scale /home/benjamin/Downloads/nebula.jpg) &
sxhkd &
exec bspwm
```

- To start X11, run ``startx``
- To exit X11, use ``super + alt + q``

### dmenu

dmenu is installed along with ``suckless-tools``. Press ``super + space`` to start it and type the name of the app you want to launch.

## DDNS

### systemd Service

The service file belongs at ``/etc/systemd/system/cloudflare-ddns.service``

```bash
# /etc/systemd/system/cloudflare-ddns.service
[Unit]
DescrIPtion=Cloudflare DDNS Update
After=network.target

[Service]
Type=oneshot
ExecStart=/home/benjamin/256/ddns.sh
WorkingDirectory=/home/benjamin/256
EnvironmentFile=/home/benjamin/256/.env
```

### systemd Timer

The timer belongs at ``/etc/systemd/system/cloudflare-ddns.timer``

```bash
# /etc/systemd/system/cloudflare-ddns.timer
[Unit]
DescrIPtion=Run Cloudflare DDNS every 5 minutes

[Timer]
OnBootSec=30s
OnUnitActiveSec=5min
Unit=cloudflare-ddns.service

[Install]
WantedBy=timers.target
```

### DDNS Usage

 - ``sudo systemctl start cloudflare-ddns.service``: start / update service
 - ``sudo systemctl stop cloudflare-ddns.service``: stop service
 - ``sudo systemctl status cloudflare-ddns.service``: check status of last service run
 - ``journalctl -u cloudflare-ddns.service --no-pager``: check logs of last service run
 - ``sudo systemctl start cloudflare-ddns.timer``: start / update timer
 - ``sudo systemctl enable cloudflare-ddns.timer``: stop timer
 - ``systemctl list-timers | grep cloudflare-ddns``: check timer status
 - ``sudo systemctl daemon-reexec``: reloads unit files after modifying either of the ``/etc/systemd/system/cloudflare-ddns.*`` files

## DHCP

A <abbr title="Dynamic Host Configuration Protocol">DHCP</abbr> reservation needed to be made for the local IP of our server in the router settings to ensure that the local IP of the server never changes. The local IP can be found by running the ``IP a`` command and looking for an <abbr title="IP Address in the format 192.168.xxx.xxx">IPV4</abbr> address under the network interface starting with ``en``.

- ``en``: signifies an *ethernet* network interface
- ``wl``: signifies *wireless LAN* network interface
- ``lo``: is the *loopback* interface

I ensured the ``DHCP Lease Time`` was set to ``forever``.

## Setting Colors via OpenRGB

To install, we visit [openrgb.org/releases.html](https://openrgb.org/releases.html), and download the latest ``Linux arm64 (Debian Bookworm .deb)``.

Next, we run a command which we expect to fail. It attempts to install OpenRGB from the ``.deb``. Installing with ``--fix-broken`` after resolves the missing dependencies:

```bash
sudo dpkg -i "(name of openrgb .deb file)"
supo apt --fix-broken install
```

Now we can use OpenRGB to set the color of the server's RGB:

```bash
# Listing devices
openrgb --list-devices
# Setting to my preferred color of blue
openrgb --device 0 --color 0044FF
```

## Clean up SSH logins

Upon logging in via ssh, we don't want any messages or system info or anything. Just a clean prompt.

```bash
sudo chmod -x /etc/update-motd.d/*
sudo truncate -s 0 /etc/motd
sudo sed -i 's/^#\?PrintMotd.*/PrintMotd no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PrintLastLog.*/PrintLastLog no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

## Sleep & Wake Monitor Automation

We disable idle screen blanking using this in `~/.xinitrc`:

```bash
xset s off; xset -dpms; xset s noblank
```
To manually blank or wake the screen:

```bash
xset dpms force off      # Sleep monitor
xset dpms force on       # Wake monitor
```
To run these automatically, we created two scripts:

## bedtime-mode.sh
Puts the monitor to sleep and turns RGB lights off.

```bash
#!/bin/bash
export DISPLAY=:0
export XAUTHORITY=/home/benjamin/.Xauthority
xset dpms force off
openrgb --device 0 --color 000000
```
## morning-wakeup.sh
Wakes the monitor and resets RGB color.

```bash
#!/bin/bash
export DISPLAY=:0
export XAUTHORITY=/home/benjamin/.Xauthority
xset dpms force on
openrgb --device 0 --color 0044FF
```
## Timers

- `sleep-monitor.timer`: runs nightly at midnight
- `wakeup-monitor.timer`: runs every morning at 9:00 AM

To install and restart everything, run:

```bash
./install-services.sh
```
