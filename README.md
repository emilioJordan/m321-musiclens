# MusicLens

Spotify-Auswertung. Modul 321, Team Leander Heiniger & Emilio Jordan.

Ein Befehl startet das ganze System: Postgres, RabbitMQ, Statistics Service, Recommendation Service und das API Gateway mit der Oberfläche.

## Start

Im Projektordner:

```bash
docker compose up -d
```

Danach http://127.0.0.1:3000 öffnen. Spotify Client ID und Secret stehen in `.env`, die Redirect URI im Dashboard ist `http://127.0.0.1:3000/auth/callback`. Die RabbitMQ-Oberfläche ist http://127.0.0.1:15672 mit Benutzer `musiclens` und Passwort `musiclens`.

Hinter einem TLS-Proxy liegt das Root-Zertifikat als `certs/extra-ca.pem`. Ohne diese Datei starten die Container normal.

## Nachrichten

Die Oberfläche lädt Auswertungen über die WebSocket-Verbindung `/ws`. Das Gateway legt den Auftrag auf RabbitMQ (`musiclens.stats.jobs` oder `musiclens.recs.jobs`). Der zuständige Service schickt Fortschritt und Ergebnis an den Exchange `musiclens.events`, das Gateway reicht sie an den Browser weiter. HTTP bleibt für Login, Health und als zusätzlicher Leseweg (`/stats/top`, `/stats/recap`, `/recommendations`).

Gespeicherte Top-Listen, Verlauf und der Live-Status liegen in Postgres.

## Abweichungen vom Projektantrag

Die Grundfunktionen bleiben: Spotify-Login, Top-Tracks und Top-Artists, zuletzt gehörte Songs, Vergleich zweier Zeiträume, Statistiken, Empfehlungen, Speicherung, Berechnung über RabbitMQ und Live-Fortschritt per WebSocket.

- Die Oberfläche ist HTML, CSS und JavaScript im Gateway, nicht React und Vite. So kommt die Seite mit `docker compose up -d` mit, ohne zweiten Dev-Server. Auf dem Entwicklungsrechner lief Vite 8 mit Node 20.16 nicht.
- Zeiträume sind die drei Spotify-Ranges: 4 Wochen, 6 Monate, Gesamt. Die Top-API kennt kein freies Datum.
- „Andere auf MusicLens“ zeigt, was andere angemeldete Nutzer gerade hören. Spotify hat keine öffentliche Freundes-API.
- Die Python-Services sprechen AMQP mit pika. Das Protokoll ist dasselbe wie bei aio-pika.
