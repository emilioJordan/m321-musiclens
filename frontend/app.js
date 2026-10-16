const loginView = document.getElementById("login-view");
const appShell = document.getElementById("app-shell");
const loginBtn = document.getElementById("login-btn");
const logoutBtn = document.getElementById("logout-btn");
const refreshBtn = document.getElementById("refresh-btn");
const loginHint = document.getElementById("login-hint");
const viewTitle = document.getElementById("view-title");
const userLine = document.getElementById("user-line");
const rangeRow = document.getElementById("range-row");
const progressWrap = document.getElementById("progress");
const progressFill = document.getElementById("progress-fill");
const progressBar = document.getElementById("progress-bar");
const progressLabel = document.getElementById("progress-label");
const compareForm = document.getElementById("compare-form");

const RANGE_LABELS = {
  short_term: "4 Wochen",
  medium_term: "6 Monate",
  long_term: "Gesamt",
};
const VIEW_TITLES = {
  overview: "Übersicht",
  compare: "Vergleich",
  recommendations: "Empfehlungen",
  history: "Verlauf",
  live: "Jetzt",
};
const VIEW_KIND = {
  overview: "dashboard",
  compare: "compare",
  recommendations: "recommendations",
  history: "history",
  live: "now",
};
const ERRORS = {
  not_authenticated: "Bitte neu anmelden.",
  spotify_stats_failed: "Spotify hat die Daten abgelehnt. Neu anmelden hilft oft.",
  recommendations_failed: "Empfehlungen sind gerade nicht erreichbar.",
  same_range: "Bitte zwei verschiedene Zeiträume wählen.",
  invalid_job: "Diese Anfrage kenne ich nicht.",
  broker_unavailable: "Der Nachrichtenbroker ist noch nicht bereit.",
  stats_failed: "Die Auswertung ist fehlgeschlagen.",
  stats_unreachable: "Der Statistics Service antwortet nicht.",
};

const state = { range: "medium_term", view: "overview", user: null };
const cache = new Map();
const inflight = new Map();
let socket = null;
let liveTimer = null;

const loginErrors = {
  config: "Spotify ist noch nicht konfiguriert. Client ID und Secret in die .env eintragen.",
  denied: "Login bei Spotify wurde abgebrochen.",
  state: "Login ungültig. Bitte noch einmal versuchen.",
  spotify: "Verbindung zu Spotify ist fehlgeschlagen.",
};

loginBtn?.addEventListener("click", () => {
  window.location.href = "/auth/login";
});
logoutBtn?.addEventListener("click", async () => {
  socket?.close();
  await fetch("/auth/logout", { method: "POST" });
  window.location.href = "/";
});
refreshBtn?.addEventListener("click", () => ensureData(state.view, true));
document.querySelectorAll(".nav [data-view]").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});
document.querySelectorAll(".range-btn").forEach((button) => {
  button.addEventListener("click", () => {
    state.range = button.dataset.range ?? "medium_term";
    document.querySelectorAll(".range-btn").forEach((item) => {
      const active = item === button;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-pressed", active ? "true" : "false");
    });
    ensureData(state.view, true);
  });
});
compareForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  ensureData("compare", true);
});

showUrlError();
loadSession();

function showUrlError() {
  const error = new URLSearchParams(window.location.search).get("error");
  if (!error || !loginHint) return;
  loginHint.textContent = loginErrors[error] ?? "Etwas ist schiefgelaufen.";
  loginHint.hidden = false;
  window.history.replaceState({}, "", "/");
}

async function loadSession() {
  try {
    const res = await fetch("/auth/me");
    if (!res.ok) return;
    showConnected(await res.json());
  } catch {
    if (loginHint) {
      loginHint.textContent = "Der Server ist nicht erreichbar.";
      loginHint.hidden = false;
    }
  }
}

function showConnected(user) {
  state.user = user;
  if (loginView) loginView.hidden = true;
  if (appShell) appShell.hidden = false;
  if (userLine) userLine.textContent = user.displayName || user.id || "";
  showView("overview");
}

function showView(name) {
  if (!VIEW_KIND[name]) return;
  state.view = name;
  document.querySelectorAll(".nav [data-view]").forEach((button) => {
    const active = button.dataset.view === name;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    const active = panel.dataset.panel === name;
    panel.hidden = !active;
    if (active) {
      panel.style.animation = "none";
      void panel.offsetWidth;
      panel.style.animation = "";
    }
  });
  if (viewTitle) viewTitle.textContent = VIEW_TITLES[name];
  if (rangeRow) rangeRow.hidden = name !== "overview" && name !== "recommendations";
  if (liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
  if (name === "live") {
    liveTimer = setInterval(() => ensureData("live", true), 15000);
  }
  ensureData(name, false);
}

function ensureData(view, force) {
  const kind = VIEW_KIND[view];
  const key = cacheKey(view);
  if (!force && cache.has(key)) {
    renderPayload(kind, cache.get(key));
    return;
  }
  if (!cache.has(key)) setStatus(view, "");
  startJob(kind, jobFields(view), key);
}

function jobFields(view) {
  if (view !== "compare") return {};
  return {
    range: document.getElementById("range-a")?.value || "short_term",
    rangeB: document.getElementById("range-b")?.value || "long_term",
  };
}

function cacheKey(view) {
  if (view === "overview") return `dashboard:${state.range}`;
  if (view === "recommendations") return `recommendations:${state.range}`;
  if (view === "compare") {
    const fields = jobFields(view);
    return `compare:${fields.range}:${fields.rangeB}`;
  }
  if (view === "history") return "history";
  return "now";
}

function startJob(kind, fields, key) {
  const jobId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  inflight.set(jobId, { kind, key });
  const body = JSON.stringify({
    type: "job",
    jobId,
    kind,
    range: fields.range || state.range,
    rangeB: fields.rangeB,
  });
  const sock = openSocket();
  if (sock.readyState === WebSocket.OPEN) sock.send(body);
  else sock.addEventListener("open", () => sock.send(body), { once: true });
}

function openSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return socket;
  }
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const next = new WebSocket(`${protocol}://${window.location.host}/ws`);
  socket = next;
  next.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const meta = inflight.get(message.jobId);
    if (message.type === "progress" && meta && meta.key === cacheKey(state.view)) {
      showProgress(message.label, message.percent);
      return;
    }
    if (!meta) return;
    inflight.delete(message.jobId);
    if (meta.key === cacheKey(state.view)) hideProgress();
    if (message.type === "error") {
      const view = viewForKind(meta.kind);
      setStatus(view, ERRORS[message.error] ?? "Die Anfrage ist fehlgeschlagen.");
      return;
    }
    if (message.type === "result") {
      cache.set(meta.key, message.payload);
      if (meta.key === cacheKey(state.view)) renderPayload(meta.kind, message.payload);
    }
  });
  next.addEventListener("close", () => {
    if (socket === next) socket = null;
  });
  next.addEventListener("error", () => {
    setStatus(state.view, "Die Live-Verbindung ist abgebrochen.");
  });
  return next;
}

function viewForKind(kind) {
  return Object.keys(VIEW_KIND).find((view) => VIEW_KIND[view] === kind) ?? state.view;
}

function renderPayload(kind, payload) {
  if (kind === "dashboard") renderDashboard(payload);
  if (kind === "compare") renderCompare(payload);
  if (kind === "recommendations") renderRecommendations(payload);
  if (kind === "history") renderHistory(payload);
  if (kind === "now") renderNow(payload);
}

function renderDashboard(data) {
  setStatus("overview", data.recentDenied ? "Zuletzt gehört braucht eine neue Anmeldung." : "");
  const minutes = document.getElementById("listen-minutes");
  const artistCount = document.getElementById("artist-count");
  const freshCount = document.getElementById("fresh-count");
  if (minutes) minutes.textContent = String(data.listeningMinutes ?? 0);
  if (artistCount) artistCount.textContent = String(data.artists?.length ?? 0);
  if (freshCount) freshCount.textContent = data.range === "long_term" ? "–" : String(data.freshArtists?.length ?? 0);
  renderBars(document.getElementById("genre-chart"), data.genres ?? [], (item) => item.count, (item) => item.name);
  renderHours(document.getElementById("hour-chart"), data.hours ?? []);
  renderBars(
    document.getElementById("popularity-chart"),
    (data.tracks ?? []).slice(0, 5),
    (item) => item.popularity ?? 0,
    (item) => item.name,
  );
  renderList(document.getElementById("artist-list"), data.artists ?? []);
  renderList(document.getElementById("track-list"), data.tracks ?? [], (item) => item.artists);
  renderList(document.getElementById("fresh-list"), data.freshArtists ?? []);
}

function renderCompare(data) {
  setStatus("compare", "");
  fillColumns(document.getElementById("compare-artists"), data.rangeA, data.rangeB, data.artists);
  fillColumns(document.getElementById("compare-tracks"), data.rangeA, data.rangeB, data.tracks, (item) => item.artists);
}

function fillColumns(host, rangeA, rangeB, groups, subtitle) {
  if (!host || !groups) return;
  const columns = [
    [`Nur ${RANGE_LABELS[rangeA] ?? ""}`, groups.onlyA ?? []],
    ["In beiden", groups.shared ?? []],
    [`Nur ${RANGE_LABELS[rangeB] ?? ""}`, groups.onlyB ?? []],
  ];
  host.innerHTML = columns
    .map(([title, items]) => {
      const list = document.createElement("ol");
      list.className = "rank-list";
      renderList(list, items, subtitle);
      return `<section class="panel"><h2>${escapeHtml(title)}</h2>${list.outerHTML}</section>`;
    })
    .join("");
}

function renderRecommendations(data) {
  setStatus("recommendations", "");
  renderList(document.getElementById("recommendation-list"), data.tracks ?? [], (item) => `Weil du ${item.because} hörst`);
  renderList(document.getElementById("suggestion-artists"), data.artists ?? [], (item) => `Neben ${item.because}`);
}

function renderHistory(data) {
  const host = document.getElementById("history-list");
  if (!host) return;
  const items = data.items ?? [];
  setStatus("history", "");
  if (!items.length) {
    host.innerHTML = '<p class="fine">Noch nichts gespeichert. Öffne Übersicht oder Vergleich, dann liegt der Stand hier.</p>';
    return;
  }
  host.innerHTML = items
    .map((item) => {
      const when = new Date(item.createdAt).toLocaleString("de-CH", { dateStyle: "medium", timeStyle: "short" });
      return `<article><details><summary><strong>${escapeHtml(item.summary)}</strong><span>${escapeHtml(when)}</span></summary><div class="inside">${historyBody(item.payload)}</div></details></article>`;
    })
    .join("");
}

function historyBody(payload) {
  if (!payload) return "";
  if (Array.isArray(payload.artists)) {
    return `<p>${escapeHtml((payload.artists ?? []).map((item) => item.name).slice(0, 5).join(", "))}</p>`;
  }
  const shared = payload.artists?.shared ?? [];
  return `<p>Gemeinsam: ${escapeHtml(shared.map((item) => item.name).join(", ") || "keine")}</p>`;
}

function renderNow(data) {
  const card = document.getElementById("now-card");
  const now = data.now ?? {};
  setStatus("live", now.denied ? "Aktueller Song braucht eine neue Anmeldung." : "");
  if (card) {
    if (!now.name) {
      card.innerHTML = "<div><p class='eyebrow'>Gerade</p><h2>Nichts am Laufen</h2><p class='fine'>Sobald Spotify spielt, steht der Titel hier.</p></div>";
    } else {
      const ratio = now.durationMs ? Math.min(100, Math.round((now.progressMs / now.durationMs) * 100)) : 0;
      card.innerHTML = `${cover(now)}<div><p class="eyebrow">${now.playing ? "Läuft" : "Pausiert"}</p><h2>${escapeHtml(now.name)}</h2><p class="fine">${escapeHtml(now.artists || "")}</p><div class="play-line"><span style="width:${ratio}%"></span></div></div>`;
    }
  }
  renderPeople(document.getElementById("others-list"), data.others ?? []);
  renderList(document.getElementById("recent-list"), data.recent ?? [], (item) => item.artists);
}

function renderPeople(list, people) {
  if (!list) return;
  if (!people.length) {
    list.innerHTML = '<li class="empty">Gerade hört sonst niemand über MusicLens.</li>';
    return;
  }
  list.innerHTML = people
    .map((person, index) => {
      const track = person.track ?? {};
      return `<li class="rank-item"><span class="rank-num">${index + 1}</span>${cover(track)}<div><strong>${escapeHtml(track.name || "Unbekannt")}</strong><span>${escapeHtml(person.displayName || "")}</span></div></li>`;
    })
    .join("");
}

function renderBars(host, items, valueOf, labelOf) {
  if (!host) return;
  if (!items.length) {
    host.innerHTML = '<p class="fine">Keine Daten.</p>';
    return;
  }
  const max = Math.max(...items.map(valueOf), 1);
  host.innerHTML = items
    .map((item) => {
      const value = valueOf(item);
      const width = Math.round((value / max) * 100);
      return `<div class="bar-row"><span>${escapeHtml(labelOf(item))}</span><span class="bar"><i style="width:${width}%"></i></span><em>${escapeHtml(value)}</em></div>`;
    })
    .join("");
}

function renderHours(host, hours) {
  if (!host) return;
  const max = Math.max(1, ...hours.map((item) => item.minutes || 0));
  host.innerHTML = hours
    .map((item) => `<span style="--h:${(item.minutes || 0) / max}" title="${item.hour}:00"></span>`)
    .join("");
}

function renderList(list, items, subtitle) {
  if (!list) return;
  if (!items.length) {
    list.innerHTML = '<li class="empty">Keine Daten für diesen Zeitraum.</li>';
    return;
  }
  list.innerHTML = items
    .map((item, index) => {
      const extra = subtitle?.(item);
      return `<li class="rank-item"><span class="rank-num">${index + 1}</span>${cover(item)}<div><strong>${escapeHtml(item.name)}</strong>${extra ? `<span>${escapeHtml(extra)}</span>` : ""}</div></li>`;
    })
    .join("");
}

function cover(item) {
  const image = typeof item.image === "string" && item.image.startsWith("https://") ? item.image : "";
  if (image) return `<img src="${escapeHtml(image)}" alt="">`;
  return `<div class="rank-fallback">${escapeHtml(item.name || "?").charAt(0)}</div>`;
}

function setStatus(view, message) {
  const node = document.getElementById(`${view}-status`);
  if (!node) return;
  node.hidden = !message;
  node.textContent = message;
}

function showProgress(label, percent) {
  if (!progressWrap || !progressFill || !progressBar || !progressLabel) return;
  progressWrap.hidden = false;
  progressFill.style.width = `${percent ?? 0}%`;
  progressBar.setAttribute("aria-valuenow", String(percent ?? 0));
  progressLabel.textContent = label || "";
}

function hideProgress() {
  if (progressWrap) progressWrap.hidden = true;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
