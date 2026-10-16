from __future__ import annotations

import json
import os
import threading
import time
from collections import Counter
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import certifi
import httpx
import pika
import psycopg
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Query

for parent in Path(__file__).resolve().parents:
    env_file = parent / ".env"
    if env_file.exists():
        load_dotenv(env_file)
        break
else:
    load_dotenv()

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://musiclens:musiclens@127.0.0.1:5432/musiclens",
)
RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://musiclens:musiclens@127.0.0.1:5672/")
SPOTIFY_API = "https://api.spotify.com/v1"
ALLOWED_RANGES = {"short_term", "medium_term", "long_term"}
EVENTS = "musiclens.events"
STATS_JOBS = "musiclens.stats.jobs"
STATS_UPDATED = "musiclens.stats.updated"
ZURICH = ZoneInfo("Europe/Zurich")
RANGE_LABELS = {
    "short_term": "4 Wochen",
    "medium_term": "6 Monate",
    "long_term": "Gesamt",
}


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


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    threading.Thread(target=consume_forever, daemon=True).start()
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
    token = bearer(authorization)
    time_range = time_range if time_range in ALLOWED_RANGES else "medium_term"
    try:
        payload = fetch_top(token, time_range)
    except httpx.HTTPStatusError as err:
        status = 401 if err.response.status_code in {401, 403} else 502
        raise HTTPException(status_code=status, detail="spotify_stats_failed") from err
    except httpx.HTTPError as err:
        raise HTTPException(status_code=502, detail="spotify_stats_failed") from err

    save_stats(payload)
    return payload


@app.get("/recap")
def recap(authorization: str | None = Header(default=None)):
    token = bearer(authorization)
    try:
        compared = compare_ranges(token, "short_term", "long_term")
    except httpx.HTTPStatusError as err:
        status = 401 if err.response.status_code in {401, 403} else 502
        raise HTTPException(status_code=status, detail="spotify_stats_failed") from err
    except httpx.HTTPError as err:
        raise HTTPException(status_code=502, detail="spotify_stats_failed") from err
    return {
        "userId": compared["userId"],
        "artists": {
            "fresh": compared["artists"]["onlyA"],
            "steady": compared["artists"]["shared"],
        },
        "tracks": {
            "fresh": compared["tracks"]["onlyA"],
            "steady": compared["tracks"]["shared"],
        },
    }


def bearer(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing_token")
    return authorization.removeprefix("Bearer ").strip()


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
            channel.queue_declare(queue=STATS_JOBS, durable=True)
            channel.queue_declare(queue=STATS_UPDATED, durable=True)
            channel.basic_qos(prefetch_count=1)
            channel.basic_consume(queue=STATS_JOBS, on_message_callback=on_job)
            print("Statistics Service hört auf RabbitMQ.")
            channel.start_consuming()
        except Exception as err:
            print(f"RabbitMQ Verbindung unterbrochen: {err}")
            time.sleep(2)
        finally:
            if connection is not None and connection.is_open:
                connection.close()


def on_job(channel, method, _properties, body) -> None:
    job = {}
    try:
        job = json.loads(body)
        handle_job(channel, job)
    except Exception as err:
        print(f"Auftrag fehlgeschlagen: {err}")
        if job.get("jobId"):
            publish_event(
                channel,
                {
                    "type": "error",
                    "jobId": job["jobId"],
                    "kind": job.get("kind", "unknown"),
                    "error": "stats_failed",
                },
            )
    finally:
        channel.basic_ack(method.delivery_tag)


def handle_job(channel, job: dict) -> None:
    kind = job.get("kind")
    job_id = job.get("jobId")
    if not job_id or not kind:
        return

    if kind == "ping":
        step(channel, job, 40, "Broker ok")
        finish(channel, job, {"ok": True, "service": "statistics"})
        return

    token = (job.get("token") or "").strip()
    if not token:
        fail(channel, job, "not_authenticated")
        return

    try:
        if kind == "dashboard":
            result = build_dashboard(channel, job, token)
        elif kind == "compare":
            result = build_compare(channel, job, token)
        elif kind == "history":
            result = build_history(channel, job, token)
        elif kind == "now":
            result = build_now(channel, job, token)
        else:
            fail(channel, job, "invalid_job")
            return
    except Handled:
        return
    except httpx.HTTPStatusError as err:
        code = "not_authenticated" if err.response.status_code in {401, 403} else "spotify_stats_failed"
        fail(channel, job, code)
        return
    except httpx.HTTPError:
        fail(channel, job, "spotify_stats_failed")
        return

    finish(channel, job, result)


def build_dashboard(channel, job: dict, token: str) -> dict:
    time_range = clean_range(job.get("range"))
    step(channel, job, 20, "Top-Listen laden")
    payload = fetch_top(token, time_range)
    save_stats(payload)
    publish_updated(channel, payload)
    step(channel, job, 55, "Zuletzt gehörte Songs laden")
    recent = safe_recent(token)
    step(channel, job, 80, "Auswerten")
    fresh: list[dict] = []
    if time_range != "long_term":
        overall = fetch_top(token, "long_term")
        fresh, _steady = split_lists(payload["artists"], overall["artists"])
    result = {
        "userId": payload["userId"],
        "range": time_range,
        "artists": payload["artists"],
        "tracks": payload["tracks"],
        "genres": tally_genres(payload["artists"]),
        "freshArtists": fresh,
        "recent": recent["tracks"][:8],
        "listeningMinutes": recent["listeningMinutes"],
        "hours": recent["hours"],
        "recentDenied": recent["denied"],
    }
    remember(
        payload["userId"],
        "dashboard",
        time_range,
        f"{RANGE_LABELS[time_range]} · {len(payload['artists'])} Artists",
        result,
    )
    return result


class Handled(Exception):
    pass


def build_compare(channel, job: dict, token: str) -> dict:
    range_a = clean_range(job.get("range"))
    range_b = clean_range(job.get("rangeB") or "long_term")
    if range_a == range_b:
        fail(channel, job, "same_range")
        raise Handled()
    step(channel, job, 35, "Beide Zeiträume laden")
    result = compare_ranges(token, range_a, range_b)
    step(channel, job, 85, "Unterschiede rechnen")
    if result.get("userId"):
        remember(
            result["userId"],
            "compare",
            f"{range_a}:{range_b}",
            f"{RANGE_LABELS[range_a]} gegen {RANGE_LABELS[range_b]}",
            result,
        )
    return result


def build_history(channel, job: dict, token: str) -> dict:
    step(channel, job, 40, "Verlauf lesen")
    profile = fetch_profile(token)
    return {"userId": profile.get("id"), "items": list_history(profile.get("id"))}


def build_now(channel, job: dict, token: str) -> dict:
    step(channel, job, 30, "Aktuellen Song prüfen")
    profile = fetch_profile(token)
    now = safe_now(token)
    step(channel, job, 70, "Andere Hörer laden")
    others = update_presence(profile, now)
    recent = safe_recent(token)
    return {
        "userId": profile.get("id"),
        "displayName": profile.get("display_name") or profile.get("id"),
        "now": now,
        "others": others,
        "recent": recent["tracks"][:12],
    }


def compare_ranges(token: str, range_a: str, range_b: str) -> dict:
    if range_a == range_b:
        raise ValueError("same_range")
    left = fetch_top(token, range_a)
    right = fetch_top(token, range_b)
    only_artists_a, shared_artists, only_artists_b = classify(left["artists"], right["artists"])
    only_tracks_a, shared_tracks, only_tracks_b = classify(left["tracks"], right["tracks"])
    return {
        "userId": left.get("userId"),
        "rangeA": range_a,
        "rangeB": range_b,
        "artists": {"onlyA": only_artists_a, "shared": shared_artists, "onlyB": only_artists_b},
        "tracks": {"onlyA": only_tracks_a, "shared": shared_tracks, "onlyB": only_tracks_b},
    }


def finish(channel, job: dict, payload: dict) -> None:
    publish_event(
        channel,
        {
            "type": "result",
            "jobId": job["jobId"],
            "kind": job["kind"],
            "payload": payload,
        },
    )


def fail(channel, job: dict, error: str) -> None:
    publish_event(
        channel,
        {
            "type": "error",
            "jobId": job["jobId"],
            "kind": job.get("kind", "unknown"),
            "error": error,
        },
    )


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


def publish_updated(channel, payload: dict) -> None:
    channel.basic_publish(
        exchange="",
        routing_key=STATS_UPDATED,
        body=json.dumps(payload).encode(),
        properties=pika.BasicProperties(content_type="application/json", delivery_mode=2),
    )


def clean_range(value: object) -> str:
    return value if isinstance(value, str) and value in ALLOWED_RANGES else "medium_term"


def fetch_profile(token: str) -> dict:
    headers = {"Authorization": f"Bearer {token}"}
    with http_client() as client:
        response = client.get(f"{SPOTIFY_API}/me", headers=headers)
        response.raise_for_status()
        return response.json()


def fetch_top(token: str, time_range: str) -> dict:
    headers = {"Authorization": f"Bearer {token}"}
    with http_client() as client:
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
        "artists": [shape_artist(artist) for artist in artists.json().get("items", [])],
        "tracks": [shape_track(track) for track in tracks.json().get("items", [])],
    }


def safe_recent(token: str) -> dict:
    empty = {"tracks": [], "listeningMinutes": 0, "hours": empty_hours(), "denied": False}
    try:
        return fetch_recent(token)
    except httpx.HTTPStatusError as err:
        empty["denied"] = err.response.status_code in {401, 403}
        return empty
    except httpx.HTTPError:
        return empty


def fetch_recent(token: str) -> dict:
    headers = {"Authorization": f"Bearer {token}"}
    with http_client() as client:
        response = client.get(
            f"{SPOTIFY_API}/me/player/recently-played",
            headers=headers,
            params={"limit": 50},
        )
        response.raise_for_status()
    items = response.json().get("items", [])
    tracks = []
    minutes = 0
    hours = empty_hours()
    for item in items:
        track = item.get("track") or {}
        if not track.get("id"):
            continue
        shaped = shape_track(track)
        shaped["playedAt"] = item.get("played_at")
        tracks.append(shaped)
        duration = track.get("duration_ms") or 0
        minutes += duration / 60000
        played_at = item.get("played_at")
        if played_at:
            stamp = datetime.fromisoformat(played_at.replace("Z", "+00:00")).astimezone(ZURICH)
            hours[stamp.hour]["minutes"] += round(duration / 60000, 1)
    return {
        "tracks": tracks,
        "listeningMinutes": round(minutes),
        "hours": hours,
        "denied": False,
    }


def safe_now(token: str) -> dict:
    try:
        return fetch_now(token)
    except httpx.HTTPStatusError as err:
        return {"playing": False, "denied": err.response.status_code in {401, 403}}
    except httpx.HTTPError:
        return {"playing": False, "denied": False}


def fetch_now(token: str) -> dict:
    headers = {"Authorization": f"Bearer {token}"}
    with http_client() as client:
        response = client.get(f"{SPOTIFY_API}/me/player/currently-playing", headers=headers)
    if response.status_code == 204 or not response.content:
        return {"playing": False, "denied": False}
    response.raise_for_status()
    body = response.json()
    item = body.get("item") or {}
    if not item.get("id"):
        return {"playing": False, "denied": False}
    track = shape_track(item)
    track["playing"] = bool(body.get("is_playing"))
    track["progressMs"] = body.get("progress_ms") or 0
    track["denied"] = False
    return track


def shape_artist(artist: dict) -> dict:
    return {
        "id": artist["id"],
        "name": artist["name"],
        "image": (artist.get("images") or [{}])[0].get("url"),
        "genres": artist.get("genres") or [],
        "popularity": artist.get("popularity") or 0,
    }


def shape_track(track: dict) -> dict:
    return {
        "id": track["id"],
        "name": track["name"],
        "artists": ", ".join(item["name"] for item in track.get("artists", [])),
        "image": (track.get("album", {}).get("images") or [{}])[0].get("url"),
        "popularity": track.get("popularity") or 0,
        "durationMs": track.get("duration_ms") or 0,
    }


def tally_genres(artists: list[dict]) -> list[dict]:
    counts: Counter[str] = Counter()
    for artist in artists:
        for genre in artist.get("genres") or []:
            counts[genre] += 1
    return [{"name": name, "count": count} for name, count in counts.most_common(6)]


def empty_hours() -> list[dict]:
    return [{"hour": hour, "minutes": 0} for hour in range(24)]


def split_lists(recent: list[dict], overall: list[dict]) -> tuple[list[dict], list[dict]]:
    overall_ids = {item["id"] for item in overall}
    fresh = [item for item in recent if item["id"] not in overall_ids]
    steady = [item for item in recent if item["id"] in overall_ids]
    return fresh, steady


def classify(left: list[dict], right: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    right_ids = {item["id"] for item in right}
    left_ids = {item["id"] for item in left}
    only_a = [item for item in left if item["id"] not in right_ids]
    shared = [item for item in left if item["id"] in right_ids]
    only_b = [item for item in right if item["id"] not in left_ids]
    return only_a, shared, only_b


def init_db() -> None:
    for attempt in range(1, 16):
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
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS snapshots (
                        id BIGSERIAL PRIMARY KEY,
                        user_id TEXT NOT NULL,
                        kind TEXT NOT NULL,
                        time_range TEXT,
                        summary TEXT NOT NULL,
                        payload JSONB NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS now_playing (
                        user_id TEXT PRIMARY KEY,
                        display_name TEXT NOT NULL,
                        image TEXT,
                        payload JSONB NOT NULL,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                conn.commit()
            print("Postgres bereit.")
            return
        except Exception as err:
            print(f"Postgres Versuch {attempt}: {err}")
            time.sleep(2)
    print("Postgres nicht erreichbar, Speicherung deaktiviert.")


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


def remember(user_id: str | None, kind: str, time_range: str, summary: str, payload: dict) -> None:
    if not user_id:
        return
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=3) as conn:
            latest = conn.execute(
                """
                SELECT created_at FROM snapshots
                WHERE user_id = %s AND kind = %s AND time_range = %s
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (user_id, kind, time_range),
            ).fetchone()
            if latest is not None:
                age = datetime.now(tz=latest[0].tzinfo) - latest[0]
                if age.total_seconds() < 3600:
                    return
            conn.execute(
                """
                INSERT INTO snapshots (user_id, kind, time_range, summary, payload)
                VALUES (%s, %s, %s, %s, %s::jsonb)
                """,
                (user_id, kind, time_range, summary, json.dumps(payload)),
            )
            conn.commit()
    except Exception as err:
        print(f"Verlauf konnte nicht gespeichert werden: {err}")


def list_history(user_id: str | None) -> list[dict]:
    if not user_id:
        return []
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=3) as conn:
            rows = conn.execute(
                """
                SELECT id, kind, time_range, summary, payload, created_at
                FROM snapshots
                WHERE user_id = %s
                ORDER BY created_at DESC
                LIMIT 20
                """,
                (user_id,),
            ).fetchall()
    except Exception as err:
        print(f"Verlauf konnte nicht gelesen werden: {err}")
        return []
    return [
        {
            "id": row[0],
            "kind": row[1],
            "timeRange": row[2],
            "summary": row[3],
            "payload": row[4],
            "createdAt": row[5].isoformat(),
        }
        for row in rows
    ]


def update_presence(profile: dict, now: dict) -> list[dict]:
    user_id = profile.get("id")
    if not user_id:
        return []
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=3) as conn:
            if now.get("playing"):
                conn.execute(
                    """
                    INSERT INTO now_playing (user_id, display_name, image, payload)
                    VALUES (%s, %s, %s, %s::jsonb)
                    ON CONFLICT (user_id)
                    DO UPDATE SET
                        display_name = EXCLUDED.display_name,
                        image = EXCLUDED.image,
                        payload = EXCLUDED.payload,
                        updated_at = NOW()
                    """,
                    (
                        user_id,
                        profile.get("display_name") or user_id,
                        (profile.get("images") or [{}])[0].get("url"),
                        json.dumps(now),
                    ),
                )
            else:
                conn.execute("DELETE FROM now_playing WHERE user_id = %s", (user_id,))
            rows = conn.execute(
                """
                SELECT user_id, display_name, image, payload
                FROM now_playing
                WHERE updated_at > NOW() - INTERVAL '2 minutes' AND user_id <> %s
                ORDER BY updated_at DESC
                """,
                (user_id,),
            ).fetchall()
            conn.commit()
    except Exception as err:
        print(f"Live-Status konnte nicht gespeichert werden: {err}")
        return []
    return [
        {
            "userId": row[0],
            "displayName": row[1],
            "image": row[2],
            "track": row[3],
        }
        for row in rows
    ]
