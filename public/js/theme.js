(function () {
  var root = document.documentElement;
  var toggle = document.getElementById("theme-toggle");

  if (!toggle) {
    return;
  }

  function getTheme() {
    return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function renderLabel(theme) {
    var isDark = theme === "dark";
    toggle.textContent = isDark ? "Světlý režim" : "Tmavý režim";
    toggle.setAttribute("aria-pressed", isDark ? "true" : "false");
  }

  renderLabel(getTheme());

  toggle.addEventListener("click", function () {
    var nextTheme = getTheme() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", nextTheme);
    try {
      localStorage.setItem("theme", nextTheme);
    } catch (error) {
      // Ignore storage failures silently.
    }
    renderLabel(nextTheme);
  });
})();
