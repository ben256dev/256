# 256 Home Server

## DDNS

### systemd Service

The service file belongs at ``/etc/systemd/system/cloudflare-ddns.service``

```bash
# /etc/systemd/system/cloudflare-ddns.service
[Unit]
Description=Cloudflare DDNS Update
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
Description=Run Cloudflare DDNS every 5 minutes

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
 - ``sudo systemctl daemon-reexec``: reloads unit files after modiying either of the ``/etc/systemd/system/cloudflare-ddns.*`` files

