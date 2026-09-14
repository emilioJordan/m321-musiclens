# MusicLens

MusicLens ist ein Schulprojekt im Modul 321 («Verteilte Systeme programmieren»).

Die geplante Anwendung soll das persönliche Spotify-Hörverhalten analysieren. Später sollen unter anderem Statistiken, frei wählbare Recaps, Zeitvergleiche sowie personalisierte Song- und Künstlerempfehlungen umgesetzt werden.

## Aktueller Stand

Dieses Repository enthält zunächst nur ein minimales Grundgerüst für den ersten Push.

Vorhanden sind:

- eine einfache `Main`-Klasse
- eine `.gitignore`
- dieses README

Die eigentliche verteilte Architektur und die einzelnen Services werden später schrittweise ergänzt.

## Geplante Architektur

Für MusicLens sind gemäss Projektantrag folgende Komponenten vorgesehen:

- React-Frontend mit TypeScript und Vite
- API Gateway mit Node.js / Express
- Statistics Service mit Python / FastAPI
- Recommendation Service mit Python / FastAPI
- RabbitMQ als Message Broker
- PostgreSQL als Datenbank
- Spotify Web API als externe Schnittstelle
- REST und WebSocket für die Kommunikation mit dem Frontend

## Projektstruktur

```text
musiclens-grundgeruest/
├── src/
│   └── Main.java
├── .gitignore
└── README.md
```

## Starten

Voraussetzung: Java ist lokal installiert.

Kompilieren:

```bash
javac src/Main.java
```

Starten:

```bash
java -cp src Main
```

Ausgabe:

```text
MusicLens gestartet.
```

## Geplante nächste Schritte

Als Nächstes kann die eigentliche Projektstruktur für die verteilte Anwendung aufgebaut werden, zum Beispiel mit getrennten Ordnern für Frontend, API Gateway, Statistics Service und Recommendation Service.

## Team

Leander Heiniger & Emilio Jordan

## Modul

Modul 321 – Verteilte Systeme programmieren
