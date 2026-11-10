#!/bin/bash
# Keep the Sumo Arena server and its public Serveo tunnel alive.
# Started once under setsid; checks every 60s and restarts only what is down.
# Logs live under ./logs so a reboot does not erase the evidence.
cd "$(dirname "$0")" || exit 1
mkdir -p logs

# cron starts this with PATH=/usr/bin:/bin; node lives under nvm here.
export PATH="/home/sck/.nvm/versions/node/v22.23.2/bin:$PATH"

HOST=sumo-arena-max.serveousercontent.com
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes)
LOG=logs/keepalive.log

echo "$(date -u +%FT%TZ) keepalive start (pid $$)" >> "$LOG"

while true; do
  if ! curl -s -m 4 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    echo "$(date -u +%FT%TZ) server down, restarting" >> "$LOG"
    setsid nohup node server.mjs >> logs/server.log 2>&1 &
    sleep 2
  fi
  if ! pgrep -f "R ${HOST}:80:localhost:3000" >/dev/null 2>&1; then
    echo "$(date -u +%FT%TZ) tunnel down, restarting" >> "$LOG"
    setsid nohup ssh "${SSH_OPTS[@]}" -R "${HOST}:80:localhost:3000" serveo.net >> logs/serveo.log 2>&1 &
  fi
  sleep 60
done
