from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

import certifi
import httpx
import pika
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Query

for parent in Path(__file__).resolve().parents:
    env_file = parent / ".env"
    if env_file.exists():
        load_dotenv(env_file)
        break
else:
    load_dotenv()

STATS_SERVICE_URL = os.getenv("STATS_SERVICE_URL", "http://127.0.0.1:8001").rstrip("/")
RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://musiclens:musiclens@127.0.0.1:5672/")
SPOTIFY_API = "https://api.spotify.com/v1"
ALLOWED_RANGES = {"short_term", "medium_term", "long_term"}
EVENTS = "musiclens.events"
RECS_JOBS = "musiclens.recs.jobs"
STATS_UPDATED = "musiclens.stats.updated"

latest_by_user: dict[str, dict] = {}


def http_client() -> httpx.Client:
    extra = Path(os.getenv("EXTRA_CA_FILE", ""))
    verify: str | bool = True
    if extra.is_file() and extra.stat().st_size > 0:
        bundle = Path("/tmp/musiclens-ca.pem")
        bundle.write_text(
            Path(certifi.where()).read_text(encoding="utf-8") + "\n" + extra.read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        verify = str(bundle)
    return httpx.Client(timeout=20.0, verify=verify)


app = FastAPI(title="MusicLens Recommendation Service")


@app.on_event("startup")
def start_consumer():
    threading.Thread(target=consume_forever, daemon=True).start()


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
        suggestions, artists = suggest(token, stats)
    except httpx.HTTPStatusError as err:
        status = err.response.status_code if err.response.status_code in {401, 403} else 502
        raise HTTPException(status_code=status, detail="recommendations_failed") from err
    except httpx.HTTPError as err:
        raise HTTPException(status_code=502, detail="recommendations_failed") from err

    return {
        "range": time_range,
        "userId": stats.get("userId"),
        "tracks": suggestions,
        "artists": artists,
    }


def consume_forever() -> None:
    while True:
        connection = None
        try:
            params = pika.URLParameters(RABBITMQ_URL)
            params.heartbeat = 60
            params.socket_timeout = 10
            params.blocked_connection_timeout = 10
            connection = pika.BlockingConnection(params)
            channel = connection.channel()
            channel.exchange_declare(exchange=EVENTS, exchange_type="topic", durable=True)
            channel.queue_declare(queue=RECS_JOBS, durable=True)
            channel.queue_declare(queue=STATS_UPDATED, durable=True)
            channel.basic_qos(prefetch_count=1)
            channel.basic_consume(queue=STATS_UPDATED, on_message_callback=on_stats)
            channel.basic_consume(queue=RECS_JOBS, on_message_callback=on_job)
            print("Recommendation Service hört auf RabbitMQ.")
            channel.start_consuming()
        except Exception as err:
            print(f"RabbitMQ Verbindung unterbrochen: {err}")
            time.sleep(2)
        finally:
            if connection is not None and connection.is_open:
                connection.close()


def on_stats(channel, method, _properties, body) -> None:
    try:
        payload = json.loads(body)
        user_id = payload.get("userId")
        if user_id and payload.get("artists"):
            latest_by_user[user_id] = payload
    except Exception as err:
        print(f"Stats-Event ungültig: {err}")
    finally:
        channel.basic_ack(method.delivery_tag)


def on_job(channel, method, _properties, body) -> None:
    job = {}
    try:
        job = json.loads(body)
        handle_job(channel, job)
    except Exception as err:
        print(f"Empfehlung fehlgeschlagen: {err}")
        if job.get("jobId"):
            publish_event(
                channel,
                {
                    "type": "error",
                    "jobId": job["jobId"],
                    "kind": job.get("kind", "recommendations"),
                    "error": "recommendations_failed",
                },
            )
    finally:
        channel.basic_ack(method.delivery_tag)


def handle_job(channel, job: dict) -> None:
    kind = job.get("kind")
    if not job.get("jobId") or not kind:
        return
    if kind == "ping":
        step(channel, job, 40, "Broker ok")
        publish_event(
            channel,
            {
                "type": "result",
                "jobId": job["jobId"],
                "kind": kind,
                "payload": {"ok": True, "service": "recommendation"},
            },
        )
        return
    if kind != "recommendations":
        publish_event(
            channel,
            {"type": "error", "jobId": job["jobId"], "kind": kind, "error": "invalid_job"},
        )
        return

    token = (job.get("token") or "").strip()
    if not token:
        publish_event(
            channel,
            {
                "type": "error",
                "jobId": job["jobId"],
                "kind": kind,
                "error": "not_authenticated",
            },
        )
        return

    time_range = job.get("range") if job.get("range") in ALLOWED_RANGES else "medium_term"
    try:
        step(channel, job, 25, "Hörverhalten laden")
        stats = load_stats(token, time_range)
        step(channel, job, 65, "Neue Songs suchen")
        tracks, artists = suggest(token, stats)
    except httpx.HTTPStatusError as err:
        code = "not_authenticated" if err.response.status_code in {401, 403} else "recommendations_failed"
        publish_event(
            channel,
            {"type": "error", "jobId": job["jobId"], "kind": kind, "error": code},
        )
        return
    except httpx.HTTPError:
        publish_event(
            channel,
            {
                "type": "error",
                "jobId": job["jobId"],
                "kind": kind,
                "error": "recommendations_failed",
            },
        )
        return

    publish_event(
        channel,
        {
            "type": "result",
            "jobId": job["jobId"],
            "kind": kind,
            "payload": {
                "range": time_range,
                "userId": stats.get("userId"),
                "tracks": tracks,
                "artists": artists,
            },
        },
    )


def load_stats(token: str, time_range: str) -> dict:
    profile = spotify_profile(token)
    user_id = profile.get("id")
    cached = latest_by_user.get(user_id) if user_id else None
    if cached and cached.get("range") == time_range and cached.get("artists"):
        return cached

    with http_client() as client:
        response = client.get(
            f"{STATS_SERVICE_URL}/top",
            params={"range": time_range},
            headers={"Authorization": f"Bearer {token}"},
        )
        response.raise_for_status()
        return response.json()


def spotify_profile(token: str) -> dict:
    with http_client() as client:
        response = client.get(
            f"{SPOTIFY_API}/me",
            headers={"Authorization": f"Bearer {token}"},
        )
        response.raise_for_status()
        return response.json()


def suggest(token: str, stats: dict) -> tuple[list[dict], list[dict]]:
    known_track_ids = {track["id"] for track in stats.get("tracks", [])}
    known_artist_ids = {artist["id"] for artist in stats.get("artists", [])}
    artists = stats.get("artists", [])[:3]
    if not artists:
        return [], []

    headers = {"Authorization": f"Bearer {token}"}
    suggestions: list[dict] = []
    suggested_artists: list[dict] = []
    seen_tracks = set(known_track_ids)
    seen_artists = set(known_artist_ids)

    with http_client() as client:
        profile = client.get(f"{SPOTIFY_API}/me", headers=headers)
        profile.raise_for_status()
        market = profile.json().get("country") or "CH"

        for artist in artists:
            for track in find_tracks(client, headers, artist, market):
                track_id = track.get("id")
                if not track_id or track_id in seen_tracks:
                    continue
                seen_tracks.add(track_id)
                image = track.get("image")
                if image is None:
                    image = (track.get("album", {}).get("images") or [{}])[0].get("url")
                label = track.get("artists_label") or ", ".join(
                    item["name"] for item in track.get("artists", [])
                )
                suggestions.append(
                    {
                        "id": track_id,
                        "name": track["name"],
                        "artists": label,
                        "image": image,
                        "because": artist["name"],
                    }
                )
                for person in track.get("artists", []):
                    person_id = person.get("id")
                    if not person_id or person_id in seen_artists:
                        continue
                    seen_artists.add(person_id)
                    suggested_artists.append({"id": person_id, "name": person["name"], "because": artist["name"]})
                if len(suggestions) >= 8:
                    return suggestions, suggested_artists[:6]

    return suggestions, suggested_artists[:6]


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
            continue
        for track in listing.json().get("items", []):
            track["image"] = image
            track["artists_label"] = ", ".join(item["name"] for item in track.get("artists", []))
            tracks.append(track)
    return tracks


def step(channel, job: dict, percent: int, label: str) -> None:
    publish_event(
        channel,
        {
            "type": "progress",
            "jobId": job["jobId"],
            "kind": job["kind"],
            "percent": percent,
            "label": label,
        },
    )


def publish_event(channel, event: dict) -> None:
    channel.basic_publish(
        exchange=EVENTS,
        routing_key=f"job.{event['jobId']}",
        body=json.dumps(event).encode(),
        properties=pika.BasicProperties(content_type="application/json", delivery_mode=2),
    )
