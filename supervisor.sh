#!/usr/bin/env bash
# Restart the marathon bot on crash/OOM; MAINCRAFT_AUTOCLEAR resumes !clear.
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
cd "$HOME/repos/maincraft/agent" || exit 1
export MAINCRAFT_AUTOCLEAR=1
export MAINCRAFT_CONFIG=/tmp/config.marathon.json
n=0
while true; do
  n=$((n+1))
  echo "=== supervisor: bot attempt #$n at $(date -Is) ===" >> "$HOME/repos/maincraft/logs/supervisor.log"
  node --max-old-space-size=8192 src/index.js --config /tmp/config.marathon.json \
      >> "$HOME/repos/maincraft/logs/bot.log" 2>&1
  code=$?
  echo "=== supervisor: bot exit code=$code at $(date -Is), restart in 10s ===" >> "$HOME/repos/maincraft/logs/supervisor.log"
  sleep 10
done
