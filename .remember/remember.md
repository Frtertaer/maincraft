# Handoff

## State

Local Paper 1.21.1 build 133 is installed and verified in `D:\maincraft\server`; Minecraft EULA was explicitly accepted. Portable Microsoft OpenJDK 21.0.12 is under `.runtime` and runtime scripts auto-detect it. The server is hard-bound to `127.0.0.1` with `online-mode=false`.

The Node 24 Mineflayer agent uses the external secret `C:\Users\user\Desktop\opus4.8api.txt`; the duplicate workspace secret was removed. The configured third-party endpoint reports exact model ID `claude-opus-5`, but proxy-backed model identity cannot be independently proven.

Security upgrades: config validation, HTTPS host pinning, timeouts/retries/budgets, console-only vision, player commands off, no screen capture, loopback-only local viewer, reconnect/backoff. `canvas` is installed.

Capability upgrades: craft count, safe dig/place, bounded combat, smelting, item/block use, sleep, containers, spatial world state, hazards, multi-step command tracking and budgets.

## Verified

- `npm run check`: 23/23.
- `npm run check-api`: live success.
- Paper + OpusBot connect/spawn/clean shutdown: success.
- Viewer HTTP 200 on `127.0.0.1:3007` only.
- Survival progression: bot crafted spruce planks and a crafting table; server inventory confirmed the real item.

## Run

1. `D:\maincraft\server\start-server.ps1`
2. `D:\maincraft\start-bot.ps1` (text-only) **or** `D:\maincraft\start-bot-vision.ps1` (Opus 5 vision POV)
3. Open `http://127.0.0.1:3007`
4. Vision debug frame: `D:\maincraft\logs\vision_frame.jpg` when vision agent is running

Vision: `source=viewer` raycast JPEG from `bot.world` → `messagesWithImage` / `claude-opus-5`. No desktop capture. Config: `agent\config.vision.json`.

Full dragon completion remains unproven and needs deterministic high-level Nether/stronghold/dragon skills. Do not claim completion without an observed server-side win condition.
