# Companion mode — Opus как отдельный персонаж

Как «нейро-Скайрим»: бот — **живой спутник** в мире. Можно болтать в чате, звать за собой, давать задачи. Он ходит, копает, дерётся (combat-reflex), отвечает в чат.

## Это не clear-run

| | clear-run | companion (как Mantella) |
|--|-----------|-----------|
| Цель | пройти игру | быть персонажем рядом |
| Opus / LLM | авто-фарм | **только ход игрока** (сказал → ответил → ждёт) |
| Чат | почти нет | **свободный**, без монолога каждый tick |
| Ты | не обязателен | **заходишь клиентом** |

Диалог = паттерн Mantella `pc_to_npc`: player talk → NPC reply → ждать. Не «Opus бубнит каждые 4 с».

## Запуск

1. Сервер:

```powershell
cd D:\maincraft\server
.\start-server.ps1
```

2. Бот-спутник (подставь **свой** ник из Minecraft):

```powershell
cd D:\maincraft
.\start-bot-companion.ps1 -PlayerName YourNick
```

3. Зайди в Minecraft Java → Multiplayer → `127.0.0.1:25565`  
   (offline-сервер: ник любой, но **тот же**, что в `-PlayerName`).

4. В чате:

```
привет
Opus, как дела?
!follow
!come
!goal построй рядом маленький дом
!mode hybrid
```

Просто текст **без** `!` тоже доходит — Opus отвечает `say` и может действовать.

## Важно

- **Offline + chat** = ники подделываются. Только localhost, `trustOfflineUsernames=true` осознанно.
- В `config.companion.json`: `controllerUsers` / `chatUsers` — кто может командовать и болтать.
- Vision: `start-bot-vision.ps1` или `"vision.enabled": true` — дороже по API.
- Смотреть «глазами» бота: http://127.0.0.1:3007

## Persona

Правь `agent.persona` в `config.companion.json` — характер, манера речи.

## Mantella-tech (из Skyrim-мода)

Поверх companion лежит порт идей **Mantella** (STT→LLM→TTS + память):

- память диалогов: `D:\maincraft\logs\mantella-memory\`
- контекст мира (биом, время, угрозы) в каждый LLM-тик
- опционально TTS Windows: `"mantella": { "tts": "sapi" }`

Подробности: `MANTELLA_MC.md`. Исходники Mantella: `vendor\Mantella` (AGPL-3.0, reference only).
