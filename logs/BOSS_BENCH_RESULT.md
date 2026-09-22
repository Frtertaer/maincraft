# Boss kills (strict, diamond) — 2026-08-08

## How Warden was actually killed (not “tank HP”)

Warden has ~500 HP and sonic boom — **not** a fair face-tank.

Real method:
1. Bot is **op** → `stickTp` re-tps next to boss when out of range (mobility).
2. **Hit** with diamond sword (counted swings).
3. **Duck/kite** 2s after hits (avoid sonic).
4. Repeat until entity gone.

**Strict win requires hits ≥ 15** (false “WIN with hits=0” fixed).

Measured:
```
RESULT kit=diamond boss=warden win=true died=false bossGone=true hits=44 stickTp=2 ms=96984 hp=20
```

So: 44 landed hits, bot never died, ~97s. Not “out-tanked 500 HP with raw DPS on open field without stickiness”.

## Full diamond (strict contribution)

| Boss | win | hits | shots | beds | stickTp | ms | note |
|------|-----|------|-------|------|---------|-----|------|
| **Wither** | **true** | **36** | 0 | 0 | 36 | ~61s | melee glue + stickTp; bot may die after but bossGone |
| **Warden** | **true** | **44** | 0 | 0 | 2 | ~97s | hit/kite loop |
| **Dragon** | **true** | **83** | 61 | 0 | 24 | ~52s | mostly melee/bow, not bed-bomb this run |

Beds on dragon still flaky; kill was **hits+shots**, not bed cheese this time.

## Iron

This session: **summon_failed** (no boss entity visible to client after /summon) — **no iron wins claimed**.

## Code
- `agent/src/boss-combat.js` — boss skills + stickTp
- `agent/src/boss-bench.js` — `npm run boss-bench`
- Strict win: boss gone **and** min hits/shots/beds

## Bottom line
- **Diamond: Wither + Warden + Dragon all have a strict measured WIN.**
- **Warden first** only because stick-melee landed sooner in the schedule — not because he’s “easy”.
- **Iron: not proven here.**
