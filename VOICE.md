# Голос спутника: Whisper STT + живой русский TTS + LLM-память

## Выбор стека (честно)

Ты просил **ахуенный живой русский голос**. Сравнение:

| Движок | Русский | «Живость» | Офлайн | Вердикт |
|--------|---------|-----------|--------|---------|
| **edge-tts** (Microsoft Neural) | отлично | **лучший free** | нужен net | **default** |
| **Silero v4/v5** | отлично | очень хороший | да (+torch) | офлайн-запас |
| **Piper** | есть модели | средний / «робот» | да | не primary |
| Windows SAPI | ок | плоско | да | fallback |
| ElevenLabs / OpenAI TTS | top | top | cloud $ | можно позже |

**Piper не тянет «ахуенный живой» RU** → primary = **edge-tts** (`ru-RU-SvetlanaNeural` / `DmitryNeural`).  
**Whisper (faster-whisper)** — лучший opensource STT для русского.  
**LLM-саммаризация** — Opus через тот же API, каждые N реплик.

---

## Установка voice-сервера

```powershell
cd D:\maincraft\voice
.\install.ps1
# опционально офлайн Silero:
# .\install.ps1 -WithTorch

.\start-voice.ps1
# или мужской голос:
# .\start-voice.ps1 -EdgeVoice ru-RU-DmitryNeural
# качество STT:
# .\start-voice.ps1 -WhisperModel medium
```

Проверка:

```powershell
curl http://127.0.0.1:8765/health
curl http://127.0.0.1:8765/voices
```

Первый Whisper download модели (~500MB–1.5GB) — подожди.

---

## Запуск companion с голосом

1. Paper server  
2. Voice server (`start-voice.ps1`)  
3. Companion:

```powershell
cd D:\maincraft
.\start-bot-companion.ps1 -PlayerName ТвойНик
```

В `config.companion.json` уже:

```json
"mantella": {
  "tts": "edge",
  "ttsVoice": "ru-RU-SvetlanaNeural",
  "stt": "whisper",
  "voiceUrl": "http://127.0.0.1:8765",
  "summaryEveryTurns": 6,
  "llmSummary": true
}
```

### В игре

| Чат | Эффект |
|-----|--------|
| обычный текст | ответ в чат + **озвучка** (edge) |
| `!listen` / `!listen 6` | микрофон → Whisper → как реплика игрока |
| `!summary` | принудительная LLM-память |

Память: `D:\maincraft\logs\mantella-memory\`

---

## API voice (localhost)

- `GET /health`
- `GET /voices` — русские edge-голоса
- `POST /tts` `{ "text", "engine":"edge|silero|sapi", "voice", "play":true }`
- `POST /stt/mic` `{ "seconds":5, "language":"ru" }`
- `POST /stt/file` multipart wav

---

## Если edge-tts недоступен (сеть)

```json
"tts": "silero"
```
+ `.\install.ps1 -WithTorch`

Или `"tts": "sapi"`.
