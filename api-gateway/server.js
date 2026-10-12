import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import express from "express";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(rootDir, ".env") });

const PORT = Number(process.env.PORT) || 3000;
const CLIENT_ID = (process.env.SPOTIFY_CLIENT_ID ?? "").trim();
const CLIENT_SECRET = (process.env.SPOTIFY_CLIENT_SECRET ?? "").trim();
const REDIRECT_URI = (
  process.env.SPOTIFY_REDIRECT_URI ?? "http://127.0.0.1:3000/auth/callback"
).trim();
const SESSION_SECRET = (process.env.SESSION_SECRET ?? "musiclens-dev-secret").trim();
const STATS_SERVICE_URL = (
  process.env.STATS_SERVICE_URL ?? "http://127.0.0.1:8001"
).trim();
const SCOPES = [
  "user-read-private",
  "user-read-email",
  "user-top-read",
  "user-read-recently-played",
].join(" ");

const cookieBase = {
  httpOnly: true,
  sameSite: "lax",
  signed: true,
  path: "/",
};

const app = express();
app.use(cookieParser(SESSION_SECRET));
app.use(express.static(join(rootDir, "frontend")));

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

  const allowedRanges = new Set(["short_term", "medium_term", "long_term"]);
  const timeRange = allowedRanges.has(req.query.range)
    ? req.query.range
    : "medium_term";

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

app.listen(PORT, () => {
  console.log(`MusicLens läuft auf http://127.0.0.1:${PORT}`);
});

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
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString(
    "base64",
  );

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
