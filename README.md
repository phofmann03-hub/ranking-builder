# Ranking Video Builder

Web-App zum Erstellen von Ranking-Videos (TikTok/Reels/Shorts) im Format 1080×1920 – läuft komplett im Browser, auch auf dem iPhone in Safari. Es wird nichts hochgeladen.

## Funktionen
- Mehrere Clips (MP4/MOV) hinzufügen, pro Clip Platz, Name, Dauer (Standard 7 s) und Startzeit
- Reihenfolge per Drag & Drop (Griff ☰) oder ▲/▼
- Titel oben durchgehend, große Platznummer + Name unten (weiße Schrift, schwarze Kontur)
- Clips werden auf 9:16 zugeschnitten (füllend)
- Gesamtlänge mit Warnung unter 61 Sekunden
- Vorschau und Export als MP4, danach Teilen / In Fotos sichern

## Technik
Canvas + `MediaRecorder` statt ffmpeg.wasm: Safari auf iOS nimmt damit nativ H.264/AAC in MP4 auf, Hardware-beschleunigt und ohne riesigen WASM-Download oder Speicherprobleme. Der Export läuft in Echtzeit. Ton wird über Web Audio übernommen.

## Test
```
node tests/e2e.mjs <ordner-mit-testclips> <ausgabeordner>
```
(Playwright/Chromium; erwartet `c1_landscape.webm`, `c2_portrait.mp4`, `c3_short_noaudio.webm`, `c4_full.webm`.)
