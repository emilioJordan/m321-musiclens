const loginBtn = document.getElementById("login-btn");
const hint = document.getElementById("login-hint");

loginBtn?.addEventListener("click", () => {
  hint?.removeAttribute("hidden");
});
