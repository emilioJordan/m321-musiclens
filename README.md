# MusicLens

Spotify-Auswertung im Stil von Wrapped. Modul 321, Team Leander Heiniger & Emilio Jordan.

## Spotify-App

1. App erstellen unter https://developer.spotify.com/dashboard
2. Redirect URI eintragen: `http://127.0.0.1:3000/auth/callback`
3. Client ID und Client Secret in `.env` kopieren
4. Im Dashboard unter **User Management** das eigene Spotify-Konto hinzufügen (Development Mode)

```bash
cp .env.example .env
```

## Starten

```bash
cd api-gateway
npm install
npm start
```

Dann http://127.0.0.1:3000 öffnen.
