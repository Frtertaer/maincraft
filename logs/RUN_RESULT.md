# Run result (measured)

Timestamp (local bot log): 2026-08-07 ~19:50–19:52

## API
- check-api: **ok=true**
- model: **claude-opus-5**
- key file: `C:\Users\user\Desktop\opus4.8api.txt`
- tokens_remaining (at check): **26737671** / 30000000

## Server (this PC)
- Paper Java PID: listening **127.0.0.1:25565**
- Done time: **13.654s**
- online-mode: **false**
- server-ip: **127.0.0.1**

## OpusBot (separate character)
- username: **OpusBot**
- UUID: `53f927d4-9c5d-3cf4-a8de-133fd1b7468e`
- Spawn: **(192.5, 87, -7.39)** world 1.21.1
- Chat: `Opus 5 online | mode=auto | combat=auto@50ms | vision=off`
- Viewer: `http://127.0.0.1:3007`

## Progression (brain ticks 1–11, ~2 min)
| tick | action (from LLM) |
|------|-------------------|
| 1–2 | craft `crafting_table` |
| 3 | goto safety / lower Y |
| 4–5 | equip `wooden_pickaxe` |
| 6–10 | dig stone (cobble) |
| 11 | craft `stone_pickaxe` |

Inventory observed in think: **4 cobblestone, 6 sticks**, wooden pick equipped.

Server advancement: **Monster Hunter** (OpusBot killed a monster).

## Latency
| Layer | Interval | Measured |
|-------|----------|----------|
| Combat reflex | config **50 ms** | pure `_tick` avg **0.002 ms** (200 loops / 0.5 ms total) |
| Opus strategy brain | **tickMs=3000** | LLM step ~8–15 s including network (see bot log gaps) |

## Tests
- `npm run selftest`: **pass=34 fail=0**

## How to reproduce
```powershell
# server
$java = "D:\maincraft\.runtime\microsoft-jdk-21\jdk-21.0.12+8\bin\java.exe"
Start-Process $java -ArgumentList "-Xms2G","-Xmx4G","-jar","paper.jar","--nogui" -WorkingDirectory "D:\maincraft\server"

# bot
cd D:\maincraft\agent
node src/index.js
```
