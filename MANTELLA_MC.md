# Mantella → Minecraft (архитектура)

Репозиторий Mantella (Skyrim/FO4 AI NPC):  
https://github.com/art-from-the-machine/Mantella — **AGPL-3.0**

Клон для справки: `D:\maincraft\vendor\Mantella`  
Мы **не** встраиваем их Python-код в продукт 1:1 (AGPL), а **перенесли технологию** в Node:

## Пайплайн Mantella

```
Голос игрока → STT (Whisper/Moonshine)
     → Context (bio, location, time, memory summaries)
     → LLM
     → sentences → TTS (Piper/xVASynth/XTTS)
     → действия в игре (Papyrus/HTTP)
```

## Наш Minecraft-пайплайн (как Mantella pc_to_npc)

```
[ждём игрока]  ← mantella.turnBased=true: LLM НЕ крутится сам
     ↓
Чат Minecraft → MantellaConversation.onPlayerChat
     → Memory (jsonl + summary.txt)
     → Context (биом, время, HP, мобы, память)
     → Brain / Opus ОДИН ход (JSON action + say)
     → bot.chat(say) + executeAction (Mineflayer)
     → optional TTS
     → снова [ждём игрока]
```

Без `turnBased` (старый hybrid-тик) бот бубнил «я рядом / дерево / укрытие» каждые ~4 с — это НЕ Mantella.

| Mantella | Minecraft (maincraft) |
|----------|------------------------|
| Character bio | `agent.persona` |
| Conversation summaries | `logs/mantella-memory/<world>/<char>/summary.txt` |
| Chat log | `.../chat.jsonl` |
| Context location/time/weather | `mantella/context.js` из Mineflayer world |
| STT | слот (`mantella.stt=none`, Whisper позже) |
| TTS | `mantella.tts=none\|sapi` |
| Game bridge HTTP | Mineflayer in-process |

## Файлы

- `agent/src/mantella/memory.js`
- `agent/src/mantella/context.js`
- `agent/src/mantella/conversation.js`
- wired in `brain.js` + `index.js` when `mantella.enabled` / `companionMode`

## Запуск companion + Mantella-память

```powershell
cd D:\maincraft
.\start-bot-companion.ps1 -PlayerName YourNick
```

Голос (грубый, Windows):

```json
"mantella": { "tts": "sapi" }
```

## Лицензия

Mantella upstream: **GNU AGPL-3.0**.  
Наш порт — **оригинальная реализация** паттернов под MC; vendor-клон только для reference.  
При распространении продукта с копиями AGPL-кода соблюдай AGPL; при чистом port без их исходников — как у основного maincraft.

## Что ещё можно стянуть из Mantella

1. Whisper STT (локально) → текст в `onPlayerChat`
2. Piper TTS (локально) вместо SAPI
3. LLM-summarizer второй моделью (как `summary_client`)
4. Multi-NPC radiant (несколько ботов болтают)
5. Tool-calling actions schema как у FunctionManager
