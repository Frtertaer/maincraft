---
name: testing-maincraft-e2e
description: How to run the maincraft two-mind Minecraft bot E2E on Linux (Paper server + Node bot + controller)
---

# Testing maincraft E2E on Linux

## Environment
- Node is NOT in PATH: `export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH` (needs >=22).
- System Java is 17 — Paper 1.21.x needs Java 21. Download Temurin once:
  `curl -sSL -o jdk21.tar.gz 'https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse'` → untar to `~/tools/jdk21/`.
- Paper 1.21.1 jar: use the fill v3 API — `https://fill.papermc.io/v3/projects/paper/versions/1.21.1/builds` → `downloads["server:default"].url` (the old api.papermc.io v2 returns 410 Gone). Verify sha256.
- `agent/.env` already holds `OPUS_API_KEY` + `TYPESAFE_API_KEY` (chmod 600, gitignored); never log values.
- `pip install laya` + torch already installed → `python3 agent/tools/laya_server.py` serves `POST :8091/decide` (~0.4s/decision on CPU).

## Running
- Server: `cd server && ~/tools/jdk21/jdk-21*/bin/java -Xmx2G -jar paper.jar nogui` — run inside `tmux` (e.g. session `mc`) so you can inject console commands via `tmux send-keys -t mc '<cmd>' Enter` (summon zombies, `data get entity OpusBot Inventory`, `setworldspawn`, `tp`).
- Bot: `cd agent && node src/index.js --config ~/repos/maincraft/agent/config.controller.json` — ALSO run inside tmux; the bot reads console commands from stdin (`status`, `goal <text>`, `stop`, `follow`, `come`...), so `tmux send-keys -t bot 'status' Enter` drives it. Tee output to a log file for grepping.
- Bot respawns at its last logout position (saved playerdata). To force world spawn: `rm server/world/playerdata/<bot-uuid>.dat*` (OpusBot's offline uuid is `53f927d4-9c5d-3cf4-a8de-133fd1b7468e`) after `setworldspawn`.
- PowerShell scripts (start-bot.ps1 etc.) do not work on Linux.
- Viewer: `http://127.0.0.1:3007` serves the page but the WebGL canvas may render blank in this box's Chrome — don't rely on it for evidence; use server `data get entity` + bot logs instead.

## Gotchas observed
- `pkill -f 'src/index.js'` kills your own shell if run via `bash -c` — use `tmux kill-session` or match a more specific pattern.
- `collect` verb targeting deep ores (`*_ore`) is restricted to surface gatherables (OOM fix); spawn in a forest for fast wood runs.
- Opus API (api.cheat-ai.shop) is flaky — empty "messages response did not contain text" replies, truncated JSON, and multi-hour `502 provider rejected` outages observed. Diagnose upstream-vs-code with raw curl: `401/405` to unauth = proxy alive; `error code: 502` in ~1s WITH the key = upstream dead (not your bug). Planner errors are logged (`[brain] planner err streak=N`); after 3 consecutive fails the controller keeps driving — no pending-command freeze.
- Watch out: zombies summoned near the bot WILL kill it if the reflex can't finish them — that's success for the reflex test (bot fights/flees without Opus).

## Companion (нейроскайрим) mode
- Adapt `agent/config.companion.json` into a copy under `/tmp` (never commit): remove `api.keyFile`, `mantella.tts="none"`, `vision.enabled=false`, `agent.chatUsers`/`controllerUsers` = your tester nick, `mantella.ambientEveryMs=30000` for faster ambient checks.
- Drive real in-game chat with a second mineflayer client on stdin (see `/tmp/tester-bot.js` from phase-2 run): it gives ground-truth evidence — `<OpusBot> …` replies, arm-swing/crouch packets, entity distance — without needing the WebGL viewer.
- Routing: plain chat needs `chatUsers` and goes to the dialogue (`[chat] from <nick>` → `mantella.respond`); `!`-commands need `controllerUsers`; `Opus, …` prefix bypasses dialogue into the planner command path.
- When the LLM is down, a temporary `testdlg` console hook in index.js (mirroring handleDialogue's post-LLM dispatch) verifies say→chat / wave→arm-swing / sit→crouch / give:→toss / task→queueCommand without a live model — revert after use.
- `!clear` needs no LLM at all: milestones print in chat, `!clear status`/`stop` respond, result lands in `logs/clear-mode-result.md`.
- During an outage every failed chat line queues a low-value planner command — expected; the queue shifts oldest.

## Verification landmarks
- Spawn: `Spawned at (...)`, chat `Opus 5 online | ... | controller=<type>`, `[controller] enabled type=...`.
- Planner: `[brain] tick=N` every ~plannerEveryTicks (8) + `[brain] think=... action=...` on success.
- Controller: `[controller] t=N verb=... conf=X.XX urg=N src=jev|laya|single|local gate=<reason> -> {action}`.
- Real-world proof: `data get entity OpusBot Inventory` in server console (server `tmux send-keys`).
