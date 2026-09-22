@echo off
set VOICE_PRELOAD=0
set WHISPER_MODEL=base
set TTS_ENGINE=edge
set EDGE_VOICE=ru-RU-SvetlanaNeural
set VOICE_HOST=127.0.0.1
set VOICE_PORT=8765
cd /d "D:\maincraft\voice"
"D:\maincraft\voice\.venv\Scripts\python.exe" server.py
