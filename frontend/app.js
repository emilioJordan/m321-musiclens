const loginCard = document.getElementById("login-card");
const connectedCard = document.getElementById("connected-card");
const loginBtn = document.getElementById("login-btn");
const logoutBtn = document.getElementById("logout-btn");
const hint = document.getElementById("login-hint");
const userName = document.getElementById("user-name");
const userEmail = document.getElementById("user-email");
const userImage = document.getElementById("user-image");
const userFallback = document.getElementById("user-fallback");

const errorMessages = {
  config:
    "Spotify ist noch nicht konfiguriert. Client ID und Secret in die .env eintragen.",
  denied: "Login bei Spotify wurde abgebrochen.",
  state: "Login ungültig. Bitte noch einmal versuchen.",
  spotify: "Verbindung zu Spotify ist fehlgeschlagen.",
};

loginBtn?.addEventListener("click", () => {
  window.location.href = "/auth/login";
});

logoutBtn?.addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  window.location.href = "/";
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
  } catch {
    showHint("Der Server ist nicht erreichbar. api-gateway mit npm start starten.");
  }
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
