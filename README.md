# MusicLens

Spotify-Auswertung im Stil von Wrapped. Modul 321, Team Leander Heiniger & Emilio Jordan.

## Starten

1. Spotify-App anlegen, Redirect URI `http://127.0.0.1:3000/auth/callback`, Keys in `.env`.
2. Infrastruktur:

```bash
cp .env.example .env
docker compose up -d
```

3. Statistics Service:

```bash
cd services/statistics
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --port 8001
```

4. Recommendation Service:

```bash
cd services/recommendation
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --port 8002
```

5. API Gateway:

```bash
cd api-gateway
npm install
npm start
```

Dann http://127.0.0.1:3000 öffnen.
