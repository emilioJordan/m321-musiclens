from __future__ import annotations

import json
import os
import threading
from pathlib import Path

import httpx
import pika
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Query

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")

STATS_SERVICE_URL = os.getenv("STATS_SERVICE_URL", "http://127.0.0.1:8001").rstrip("/")
RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1:5672/")
SPOTIFY_API = "https://api.spotify.com/v1"
STATS_QUEUE = "musiclens.stats.updated"
ALLOWED_RANGES = {"short_term", "medium_term", "long_term"}

latest_by_user: dict[str, dict] = {}

app = FastAPI(title="MusicLens Recommendation Service")


@app.on_event("startup")
def start_consumer():
    threading.Thread(target=consume_stats, daemon=True).start()


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/recommendations")
def recommendations(
    time_range: str = Query("medium_term", alias="range"),
    authorization: str | None = Header(default=None),
):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing_token")

    time_range = time_range if time_range in ALLOWED_RANGES else "medium_term"
    token = authorization.removeprefix("Bearer ").strip()

    try:
        stats = load_stats(token, time_range)
        suggestions = suggest(token, stats)
    except httpx.HTTPStatusError as err:
        status = err.response.status_code if err.response.status_code in {401, 403} else 502
        raise HTTPException(status_code=status, detail="recommendations_failed") from err
    except httpx.HTTPError as err:
        raise HTTPException(status_code=502, detail="recommendations_failed") from err

    return {
        "range": time_range,
        "userId": stats.get("userId"),
        "tracks": suggestions,
    }


def load_stats(token: str, time_range: str) -> dict:
    with httpx.Client(timeout=20.0) as client:
        response = client.get(
            f"{STATS_SERVICE_URL}/top",
            params={"range": time_range},
            headers={"Authorization": f"Bearer {token}"},
        )
        response.raise_for_status()
        return response.json()


def suggest(token: str, stats: dict) -> list[dict]:
    known_ids = {track["id"] for track in stats.get("tracks", [])}
    artists = stats.get("artists", [])[:3]
    if not artists:
        return []

    headers = {"Authorization": f"Bearer {token}"}
    suggestions: list[dict] = []
    seen = set(known_ids)

    with httpx.Client(timeout=20.0) as client:
        profile = client.get(f"{SPOTIFY_API}/me", headers=headers)
        profile.raise_for_status()
        market = profile.json().get("country") or "CH"

        for artist in artists:
            for track in find_tracks(client, headers, artist, market):
                track_id = track.get("id")
                if not track_id or track_id in seen:
                    continue
                seen.add(track_id)
                image = track.get("image")
                if image is None:
                    image = (track.get("album", {}).get("images") or [{}])[0].get("url")
                suggestions.append(
                    {
                        "id": track_id,
                        "name": track["name"],
                        "artists": track.get("artists_label")
                        or ", ".join(item["name"] for item in track.get("artists", [])),
                        "image": image,
                        "because": artist["name"],
                    }
                )
                if len(suggestions) >= 8:
                    return suggestions

    return suggestions


def find_tracks(client: httpx.Client, headers: dict, artist: dict, market: str) -> list[dict]:
    searched = search_tracks(client, headers, artist["name"], market)
    if searched:
        return searched
    return album_tracks(client, headers, artist["id"], market)


def search_tracks(client: httpx.Client, headers: dict, artist_name: str, market: str) -> list[dict]:
    response = client.get(
        f"{SPOTIFY_API}/search",
        headers=headers,
        params={
            "q": f'artist:"{artist_name}"',
            "type": "track",
            "limit": 10,
            "market": market,
        },
    )
    if response.status_code >= 400:
        print(f"Spotify-Suche {response.status_code}: {response.text[:240]}")
        return []
    return response.json().get("tracks", {}).get("items", [])


def album_tracks(client: httpx.Client, headers: dict, artist_id: str, market: str) -> list[dict]:
    albums = client.get(
        f"{SPOTIFY_API}/artists/{artist_id}/albums",
        headers=headers,
        params={"include_groups": "album,single", "market": market, "limit": 2},
    )
    if albums.status_code >= 400:
        print(f"Spotify-Alben {albums.status_code}: {albums.text[:240]}")
        return []

    tracks: list[dict] = []
    for album in albums.json().get("items", []):
        image = (album.get("images") or [{}])[0].get("url")
        listing = client.get(
            f"{SPOTIFY_API}/albums/{album['id']}/tracks",
            headers=headers,
            params={"market": market, "limit": 5},
        )
        if listing.status_code >= 400:
            print(f"Spotify-Albumtracks {listing.status_code}: {listing.text[:240]}")
            continue
        for track in listing.json().get("items", []):
            track["image"] = image
            track["artists_label"] = ", ".join(item["name"] for item in track.get("artists", []))
            tracks.append(track)
    return tracks


def consume_stats() -> None:
    try:
        params = pika.URLParameters(RABBITMQ_URL)
        params.socket_timeout = 3
        params.blocked_connection_timeout = 3
        connection = pika.BlockingConnection(params)
        channel = connection.channel()
        channel.queue_declare(queue=STATS_QUEUE, durable=True)

        def on_message(_channel, _method, _properties, body):
            payload = json.loads(body)
            user_id = payload.get("userId")
            if user_id:
                latest_by_user[user_id] = payload

        channel.basic_consume(queue=STATS_QUEUE, on_message_callback=on_message, auto_ack=True)
        print("Recommendation Service hört auf RabbitMQ.")
        channel.start_consuming()
    except Exception as err:
        print(f"RabbitMQ nicht erreichbar, Empfehlungen laufen direkt über HTTP: {err}")
