#!/bin/bash
# Watchdog: kills the bot when nothing but [mem] lines appear for 240s.
# The tick chain periodically deadlocks on an unresolved await; mem timers
# keep firing so the process looks alive. Supervisor restarts it in 10s.
LOG=/home/ubuntu/repos/maincraft/logs/bot.log
while sleep 30; do
  [ ! -f "$LOG" ] && continue
  # timestamp of last non-mem line (epoch)
  last=$(grep -av "mem\]" "$LOG" | tail -1 | grep -ao "^\[[0-9:]*\]" | tr -d '[]')
  [ -z "$last" ] && continue
  last_epoch=$(date -d "$last" +%s 2>/dev/null || echo 0)
  now=$(date +%s)
  age=$(( now - last_epoch ))
  if [ "$age" -gt 240 ]; then
    pid=$(pgrep -f "node.*src/index.js" | head -1)
    [ -n "$pid" ] && kill "$pid" && echo "[watchdog] killed hung bot pid=$pid age=${age}s" >> "$LOG"
  fi
done
