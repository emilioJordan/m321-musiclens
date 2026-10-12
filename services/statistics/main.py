from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager

import httpx
import pika
import psycopg
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Query
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://musiclens:musiclens@127.0.0.1:5432/musiclens",
)
RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1:5672/")
SPOTIFY_API = "https://api.spotify.com/v1"
ALLOWED_RANGES = {"short_term", "medium_term", "long_term"}
STATS_QUEUE = "musiclens.stats.updated"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="MusicLens Statistics Service", lifespan=lifespan)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/top")
def top_stats(
    time_range: str = Query("medium_term", alias="range"),
    authorization: str | None = Header(default=None),
):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing_token")

    time_range = time_range if time_range in ALLOWED_RANGES else "medium_term"
    token = authorization.removeprefix("Bearer ").strip()

    try:
        payload = fetch_top(token, time_range)
    except httpx.HTTPStatusError as err:
        status = 401 if err.response.status_code in {401, 403} else 502
        raise HTTPException(status_code=status, detail="spotify_stats_failed") from err
    except httpx.HTTPError as err:
        raise HTTPException(status_code=502, detail="spotify_stats_failed") from err

    save_stats(payload)
    publish_stats(payload)
    return payload


def fetch_top(token: str, time_range: str) -> dict:
    headers = {"Authorization": f"Bearer {token}"}
    with httpx.Client(timeout=20.0) as client:
        me = client.get(f"{SPOTIFY_API}/me", headers=headers)
        me.raise_for_status()
        artists = client.get(
            f"{SPOTIFY_API}/me/top/artists",
            headers=headers,
            params={"time_range": time_range, "limit": 10},
        )
        artists.raise_for_status()
        tracks = client.get(
            f"{SPOTIFY_API}/me/top/tracks",
            headers=headers,
            params={"time_range": time_range, "limit": 10},
        )
        tracks.raise_for_status()

    profile = me.json()
    return {
        "userId": profile.get("id"),
        "range": time_range,
        "artists": [
            {
                "id": artist["id"],
                "name": artist["name"],
                "image": (artist.get("images") or [{}])[0].get("url"),
            }
            for artist in artists.json().get("items", [])
        ],
        "tracks": [
            {
                "id": track["id"],
                "name": track["name"],
                "artists": ", ".join(item["name"] for item in track.get("artists", [])),
                "image": (track.get("album", {}).get("images") or [{}])[0].get("url"),
            }
            for track in tracks.json().get("items", [])
        ],
    }


def init_db() -> None:
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=3) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS top_stats (
                    user_id TEXT NOT NULL,
                    time_range TEXT NOT NULL,
                    payload JSONB NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    PRIMARY KEY (user_id, time_range)
                )
                """
            )
            conn.commit()
    except Exception as err:
        print(f"Postgres nicht erreichbar, Cache deaktiviert: {err}")


def save_stats(payload: dict) -> None:
    user_id = payload.get("userId")
    if not user_id:
        return
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=3) as conn:
            conn.execute(
                """
                INSERT INTO top_stats (user_id, time_range, payload)
                VALUES (%s, %s, %s::jsonb)
                ON CONFLICT (user_id, time_range)
                DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
                """,
                (user_id, payload["range"], json.dumps(payload)),
            )
            conn.commit()
    except Exception as err:
        print(f"Stats konnten nicht gespeichert werden: {err}")


def publish_stats(payload: dict) -> None:
    try:
        params = pika.URLParameters(RABBITMQ_URL)
        params.socket_timeout = 3
        params.blocked_connection_timeout = 3
        connection = pika.BlockingConnection(params)
        channel = connection.channel()
        channel.queue_declare(queue=STATS_QUEUE, durable=True)
        channel.basic_publish(
            exchange="",
            routing_key=STATS_QUEUE,
            body=json.dumps(payload).encode("utf-8"),
        )
        connection.close()
    except Exception as err:
        print(f"RabbitMQ nicht erreichbar, Event übersprungen: {err}")
