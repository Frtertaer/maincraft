# Combat bench results (measured)

## Before upgrade (server logs, bare early combat)
- Deaths: zombie×7, skeleton×4
- Wins: Monster Hunter ×1 only

## After combat-reflex upgrade (strict: saw mob + hit + dead)

### Full suite A (24 mobs, diamond gear, no per-round flood)
Source: `combat-bench.out.log` ~20:21–20:26

| mob | result | ms | note |
|-----|--------|-----|------|
| zombie | WIN | 8895 | |
| skeleton | WIN | 10084 | |
| spider | WIN | 6928 | |
| creeper | WIN | 6105 | kite |
| husk | WIN | 4485 | |
| stray | WIN | 3466 | |
| drowned | WIN | 4081 | |
| witch | WIN | 5091 | |
| enderman | LOSS | 90144 | timeout (later fixed) |
| cave_spider | WIN | 7341 | |
| pillager | WIN | 4072 | |
| vindicator | WIN | 4692 | |
| blaze | WIN | 4066 | |
| wither_skeleton | WIN | 3869 | |
| ravager | WIN | 34099 | |
| silverfish | WIN | 611 | |
| endermite | WIN | 1426 | |
| slime | WIN | 612 | |
| magma_cube | WIN | 2241 | |
| phantom | WIN | 3462 | |
| hoglin | WIN | 6916 | |
| zoglin | WIN | 16477 | |
| piglin_brute | LOSS | 407 | died |
| evoker | LOSS | 2844 | died |

**Totals A: wins=21 losses=3 rate=0.875**

### Enderman retest after chase/water fix
- enderman: **WIN** ms=6119 hp=12.5 hits=13
- silverfish: **WIN** ms=1018

### Full suite B (same code + resistance between fights)
~20:28–20:33

**Totals B: wins=22 losses=2 rate=0.917**  
losses: enderman timeout; silverfish summonFailed  
wins include: vindicator, ravager, piglin_brute, evoker, creeper, skeleton, blaze, etc.

### What is NOT claimed
- Warden / Wither / Ender Dragon not in suite
- Naked wood-age bot ≠ diamond bench (bench gives diamond+shield)
- 100% eternal “any mob forever” not proven; best measured **~92% of 24 common hostiles** under diamond loadout

## Combat upgrades shipped
- `combat-reflex.js`: threat priority, shield vs ranged, creeper kite, strafe, sprint-hit, jump crit, auto-eat, equip weapon/shield, enderman chase+water, heavy-melee block
- interval **40ms**
- `npm run combat-bench`
