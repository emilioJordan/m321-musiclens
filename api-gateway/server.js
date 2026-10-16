import cookie from "cookie";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import express from "express";
import amqplib from "amqplib";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(rootDir, ".env") });

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const CLIENT_ID = (process.env.SPOTIFY_CLIENT_ID ?? "").trim();
const CLIENT_SECRET = (process.env.SPOTIFY_CLIENT_SECRET ?? "").trim();
const REDIRECT_URI = (
  process.env.SPOTIFY_REDIRECT_URI ?? "http://127.0.0.1:3000/auth/callback"
).trim();
const SESSION_SECRET = (process.env.SESSION_SECRET ?? "musiclens-dev-secret").trim();
const STATS_SERVICE_URL = (
  process.env.STATS_SERVICE_URL ?? "http://127.0.0.1:8001"
).trim();
const RECOMMENDATION_SERVICE_URL = (
  process.env.RECOMMENDATION_SERVICE_URL ?? "http://127.0.0.1:8002"
).trim();
const RABBITMQ_URL = (
  process.env.RABBITMQ_URL ?? "amqp://musiclens:musiclens@127.0.0.1:5672/"
).trim();
const SCOPES = [
  "user-read-private",
  "user-read-email",
  "user-top-read",
  "user-read-recently-played",
  "user-read-currently-playing",
].join(" ");

const EVENTS = "musiclens.events";
const STATS_JOBS = "musiclens.stats.jobs";
const RECS_JOBS = "musiclens.recs.jobs";
const RANGES = new Set(["short_term", "medium_term", "long_term"]);
const STATS_KINDS = new Set(["dashboard", "compare", "history", "now", "ping-stats"]);
const RECS_KINDS = new Set(["recommendations", "ping-recs"]);

const cookieBase = {
  httpOnly: true,
  sameSite: "lax",
  signed: true,
  path: "/",
};

const jobs = new Map();
let channel = null;
let brokerLoop = false;

const app = express();
app.use(cookieParser(SESSION_SECRET));
app.use(
  express.static(join(rootDir, "frontend"), {
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-cache");
    },
  }),
);

app.get("/health", (_req, res) => {
  res.status(channel ? 200 : 503).json({ ok: Boolean(channel) });
});

app.get("/auth/login", (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    res.redirect("/?error=config");
    return;
  }

  const state = randomBytes(16).toString("hex");
  res.cookie("ml_state", state, { ...cookieBase, maxAge: 10 * 60 * 1000 });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
    show_dialog: "true",
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get("/auth/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    res.redirect("/?error=denied");
    return;
  }

  if (
    typeof code !== "string" ||
    typeof state !== "string" ||
    !req.signedCookies.ml_state ||
    state !== req.signedCookies.ml_state
  ) {
    res.redirect("/?error=state");
    return;
  }

  res.clearCookie("ml_state", { path: "/" });

  try {
    const tokens = await requestTokens({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    });
    setTokenCookies(res, tokens);
    res.redirect("/");
  } catch (err) {
    console.error("Spotify token exchange failed:", err);
    res.redirect("/?error=spotify");
  }
});

app.get("/auth/me", async (req, res) => {
  const accessToken = await getAccessToken(req, res);
  if (!accessToken) {
    res.status(401).json({ error: "not_authenticated" });
    return;
  }

  const spotifyRes = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!spotifyRes.ok) {
    res.status(401).json({ error: "spotify_profile_failed" });
    return;
  }

  const profile = await spotifyRes.json();
  res.json({
    id: profile.id,
    displayName: profile.display_name,
    email: profile.email ?? null,
    image: profile.images?.[0]?.url ?? null,
  });
});

app.post("/auth/logout", (_req, res) => {
  clearTokenCookies(res);
  res.json({ ok: true });
});

app.get("/stats/top", async (req, res) => {
  const accessToken = await getAccessToken(req, res);
  if (!accessToken) {
    res.status(401).json({ error: "not_authenticated" });
    return;
  }

  const timeRange = RANGES.has(req.query.range) ? req.query.range : "medium_term";

  try {
    const statsRes = await fetch(
      `${STATS_SERVICE_URL}/top?range=${encodeURIComponent(timeRange)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const body = await statsRes.json().catch(() => ({ error: "spotify_stats_failed" }));
    res.status(statsRes.status).json(body);
  } catch (err) {
    console.error("Statistics service unreachable:", err);
    res.status(502).json({ error: "stats_service_unreachable" });
  }
});

app.get("/stats/recap", async (req, res) => {
  const accessToken = await getAccessToken(req, res);
  if (!accessToken) {
    res.status(401).json({ error: "not_authenticated" });
    return;
  }

  try {
    const statsRes = await fetch(`${STATS_SERVICE_URL}/recap`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = await statsRes.json().catch(() => ({ error: "spotify_stats_failed" }));
    res.status(statsRes.status).json(body);
  } catch (err) {
    console.error("Statistics service unreachable:", err);
    res.status(502).json({ error: "stats_service_unreachable" });
  }
});

const server = createServer(app);
const sockets = new WebSocketServer({ server, path: "/ws" });

sockets.on("connection", (socket, request) => {
  socket.on("message", async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      socket.send(JSON.stringify({ type: "error", error: "invalid_message" }));
      return;
    }

    if (message.type !== "job") {
      return;
    }

    const kind = message.kind;
    const queue = queueFor(kind);
    const jobId = validId(message.jobId) ? message.jobId : randomUUID();
    if (!queue) {
      socket.send(JSON.stringify({ type: "error", jobId, kind, error: "invalid_job" }));
      return;
    }

    const workerKind = kind.startsWith("ping-") ? "ping" : kind;
    const range = RANGES.has(message.range) ? message.range : "medium_term";
    const rangeB = RANGES.has(message.rangeB) ? message.rangeB : "long_term";
    if (workerKind === "compare" && range === rangeB) {
      socket.send(JSON.stringify({ type: "error", jobId, kind: workerKind, error: "same_range" }));
      return;
    }

    let token = "";
    if (workerKind !== "ping") {
      token = (await tokenFromHeaders(request.headers.cookie)) ?? "";
      if (!token) {
        socket.send(JSON.stringify({ type: "error", jobId, kind: workerKind, error: "not_authenticated" }));
        return;
      }
    }

    if (!channel) {
      socket.send(JSON.stringify({ type: "error", jobId, kind: workerKind, error: "broker_unavailable" }));
      return;
    }

    jobs.set(jobId, socket);
    try {
      channel.sendToQueue(
        queue,
        Buffer.from(JSON.stringify({ jobId, kind: workerKind, range, rangeB, token })),
        { persistent: true, contentType: "application/json" },
      );
    } catch (err) {
      console.error("Auftrag nicht gesendet:", err);
      jobs.delete(jobId);
      socket.send(JSON.stringify({ type: "error", jobId, kind: workerKind, error: "broker_unavailable" }));
    }
  });

  socket.on("close", () => {
    for (const [jobId, open] of jobs) {
      if (open === socket) {
        jobs.delete(jobId);
      }
    }
  });
});

await setupBroker();
server.listen(PORT, HOST, () => {
  console.log(`MusicLens läuft auf http://127.0.0.1:${PORT}`);
});

function queueFor(kind) {
  if (STATS_KINDS.has(kind)) {
    return STATS_JOBS;
  }
  if (RECS_KINDS.has(kind)) {
    return RECS_JOBS;
  }
  return null;
}

function validId(value) {
  return typeof value === "string" && /^[0-9a-f-]{16,40}$/i.test(value);
}

async function setupBroker() {
  if (brokerLoop) {
    return;
  }
  brokerLoop = true;
  while (!channel) {
    try {
      const connection = await amqplib.connect(RABBITMQ_URL);
      connection.on("error", (err) => console.error("RabbitMQ", err.message));
      connection.on("close", () => {
        console.log("RabbitMQ Verbindung zu");
        channel = null;
        brokerLoop = false;
        setTimeout(setupBroker, 2000);
      });
      const next = await connection.createChannel();
      await next.assertExchange(EVENTS, "topic", { durable: true });
      await next.assertQueue(STATS_JOBS, { durable: true });
      await next.assertQueue(RECS_JOBS, { durable: true });
      await next.assertQueue("musiclens.stats.updated", { durable: true });
      const events = await next.assertQueue("musiclens.gateway.events", { durable: true });
      await next.bindQueue(events.queue, EVENTS, "job.*");
      await next.consume(events.queue, (msg) => {
        if (!msg) {
          return;
        }
        const event = JSON.parse(msg.content.toString());
        const socket = jobs.get(event.jobId);
        if (socket && socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(event));
        }
        if (event.type === "result" || event.type === "error") {
          jobs.delete(event.jobId);
        }
        next.ack(msg);
      });
      channel = next;
      console.log("RabbitMQ verbunden");
    } catch (err) {
      console.error("RabbitMQ noch nicht bereit:", err.message);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  brokerLoop = false;
}

async function tokenFromHeaders(cookieHeader) {
  const parsed = cookie.parse(cookieHeader ?? "");
  const unsigned = (value) => {
    if (!value) {
      return undefined;
    }
    const result = cookieParser.signedCookie(value, SESSION_SECRET);
    return result === false ? undefined : result;
  };
  return getAccessToken(
    {
      signedCookies: {
        ml_access: unsigned(parsed.ml_access),
        ml_refresh: unsigned(parsed.ml_refresh),
      },
    },
    { cookie() {}, clearCookie() {} },
  );
}

async function getAccessToken(req, res) {
  const accessToken = req.signedCookies.ml_access;
  if (accessToken) {
    return accessToken;
  }

  const refreshToken = req.signedCookies.ml_refresh;
  if (!refreshToken) {
    return null;
  }

  try {
    const tokens = await requestTokens({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    setTokenCookies(res, tokens, refreshToken);
    return tokens.access_token;
  } catch (err) {
    console.error("Spotify token refresh failed:", err);
    clearTokenCookies(res);
    return null;
  }
}

async function requestTokens(body) {
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      ...body,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!tokenRes.ok) {
    const details = await tokenRes.text();
    throw new Error(details);
  }

  return tokenRes.json();
}

function setTokenCookies(res, tokens, existingRefresh) {
  const refreshToken = tokens.refresh_token ?? existingRefresh;

  res.cookie("ml_access", tokens.access_token, {
    ...cookieBase,
    maxAge: (tokens.expires_in ?? 3600) * 1000,
  });

  if (refreshToken) {
    res.cookie("ml_refresh", refreshToken, {
      ...cookieBase,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }
}

function clearTokenCookies(res) {
  res.clearCookie("ml_access", { path: "/" });
  res.clearCookie("ml_refresh", { path: "/" });
  res.clearCookie("ml_state", { path: "/" });
}
