const loginCard = document.getElementById("login-card");
const connectedCard = document.getElementById("connected-card");
const loginBtn = document.getElementById("login-btn");
const logoutBtn = document.getElementById("logout-btn");
const hint = document.getElementById("login-hint");
const statsHint = document.getElementById("stats-hint");
const userName = document.getElementById("user-name");
const userEmail = document.getElementById("user-email");
const userImage = document.getElementById("user-image");
const userFallback = document.getElementById("user-fallback");
const artistList = document.getElementById("artist-list");
const trackList = document.getElementById("track-list");

const errorMessages = {
  config:
    "Spotify ist noch nicht konfiguriert. Client ID und Secret in die .env eintragen.",
  denied: "Login bei Spotify wurde abgebrochen.",
  state: "Login ungültig. Bitte noch einmal versuchen.",
  spotify: "Verbindung zu Spotify ist fehlgeschlagen.",
};

let currentRange = "medium_term";

loginBtn?.addEventListener("click", () => {
  window.location.href = "/auth/login";
});

logoutBtn?.addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  window.location.href = "/";
});

document.querySelectorAll(".range-btn").forEach((button) => {
  button.addEventListener("click", () => {
    currentRange = button.dataset.range ?? "medium_term";
    document.querySelectorAll(".range-btn").forEach((item) => {
      item.classList.toggle("is-active", item === button);
    });
    loadStats();
  });
});

showUrlError();
loadSession();

function showUrlError() {
  const error = new URLSearchParams(window.location.search).get("error");
  if (!error || !hint) {
    return;
  }

  hint.textContent = errorMessages[error] ?? "Etwas ist schiefgelaufen.";
  hint.hidden = false;
  window.history.replaceState({}, "", "/");
}

async function loadSession() {
  try {
    const res = await fetch("/auth/me");
    if (!res.ok) {
      return;
    }
    showConnected(await res.json());
    loadStats();
  } catch {
    showHint("Der Server ist nicht erreichbar. api-gateway mit npm start starten.");
  }
}

async function loadStats() {
  if (!artistList || !trackList) {
    return;
  }

  artistList.innerHTML = "<li class=\"rank-item\">Lade Artists…</li>";
  trackList.innerHTML = "<li class=\"rank-item\">Lade Songs…</li>";
  if (statsHint) {
    statsHint.hidden = true;
  }

  try {
    const res = await fetch(/stats/top?range=${currentRange});
    if (res.status === 401) {
      window.location.href = "/";
      return;
    }
    if (!res.ok) {
      throw new Error("stats_failed");
    }
    const data = await res.json();
    renderList(artistList, data.artists);
    renderList(trackList, data.tracks, (item) => item.artists);
  } catch {
    artistList.innerHTML = "";
    trackList.innerHTML = "";
    if (statsHint) {
      statsHint.textContent = "Auswertung konnte nicht geladen werden. Nochmal anmelden hilft oft.";
      statsHint.hidden = false;
    }
  }
}

function renderList(list, items, subtitle) {
  if (!items.length) {
    list.innerHTML = "<li class=\"rank-item\">Keine Daten für diesen Zeitraum.</li>";
    return;
  }

  list.innerHTML = items
    .map((item, index) => {
      const image = item.image
        ? <img src="${item.image}" alt="">
        : <div class="rank-fallback">${escapeHtml(item.name).charAt(0)}</div>;
      const extra = subtitle?.(item);
      return `<li class="rank-item">
        <span class="rank-num">${index + 1}</span>
        ${image}
        <div>
          <strong>${escapeHtml(item.name)}</strong>
          ${extra ? <span>${escapeHtml(extra)}</span> : ""}
        </div>
      </li>`;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function showConnected(user) {
  if (!loginCard || !connectedCard || !userName) {
    return;
  }

  loginCard.hidden = true;
  connectedCard.hidden = false;
  userName.textContent = user.displayName || user.id;

  if (userEmail) {
    userEmail.textContent = user.email ?? "";
  }

  if (user.image && userImage) {
    userImage.src = user.image;
    userImage.hidden = false;
    if (userFallback) {
      userFallback.hidden = true;
    }
    return;
  }

  if (userImage) {
    userImage.hidden = true;
  }
  if (userFallback) {
    userFallback.hidden = false;
    userFallback.textContent = (user.displayName || user.id || "?").charAt(0).toUpperCase();
  }
}

function showHint(message) {
  if (!hint) {
    return;
  }
  hint.textContent = message;
  hint.hidden = false;
}