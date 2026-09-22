TLauncher — ЧИСТЫЙ запуск (без установщика)
==========================================

ЧТО СДЕЛАНО
-----------
1. Установщик TLauncher-Installer.exe — это бандлер (в файле есть маркеры
   Offer / toolbar). Он ПОЛОЖЕН В КАРАНТИН, не запускай его:

   _quarantine_installer\TLauncher-Installer.exe.DONT_RUN

2. Рабочий чистый путь — только JAR (без NSIS/offer-инсталлятора):

   clean\TLauncher.jar
   start-tlauncher-clean.ps1

КАК ЗАПУСТИТЬ
-------------
  cd D:\maincraft\tools\tlauncher
  .\start-tlauncher-clean.ps1

  Ник = как в companion:
    D:\maincraft\start-bot-companion.ps1 -PlayerName ТвойНик

  Сервер:
    127.0.0.1:25565
    Версия: 1.21.1

ЧЕСТНО
------
- Мы НЕ «вычищаем вирусы из EXE побайтово» (это лотерея и часто ломает файл).
- Мы ВЫКИДЫВАЕМ установщик — там и сидит лабуда (офферы, тулбары).
- Сам TLauncher.jar — закрытый продукт; встроенную рекламу/аккаунт TL
  внутри JAR мы не патчим. Для 100% open-source лаунчера лучше Prism Launcher.

ФАЙЛЫ
-----
  start-tlauncher-clean.ps1   ← запускай это
  clean\TLauncher.jar         ← чистый jar
  TLauncher.jar               ← обёртка-zip с сайта (можно не трогать)
  _quarantine_installer\      ← НЕ запускать
