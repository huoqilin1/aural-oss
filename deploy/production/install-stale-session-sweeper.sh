#!/usr/bin/env bash
set -euo pipefail

# One-time installation of the stale-session sweeper as a systemd timer.
# Idempotent: safe to re-run on every deploy.

[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }
SCRIPT_DIR=$(dirname "$(readlink -f "$0")")

install -m 0755 "$SCRIPT_DIR/stale-session-sweeper.sh" /usr/local/sbin/aural-stale-session-sweeper

cat > /etc/systemd/system/aural-stale-session-sweeper.service <<'UNIT'
[Unit]
Description=Aural stale interview session sweeper

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/aural-stale-session-sweeper
UNIT

cat > /etc/systemd/system/aural-stale-session-sweeper.timer <<'UNIT'
[Unit]
Description=Hourly Aural stale session sweep

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now aural-stale-session-sweeper.timer
systemctl start aural-stale-session-sweeper.service
echo "stale-session sweeper installed and first sweep executed"
