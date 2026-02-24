/**
 * theme.js — Dark/Light theme management
 * Saves preference to localStorage and toggles via data-theme attribute
 */

const Theme = (() => {
  const STORAGE_KEY = "lp_theme";
  const ROOT = document.documentElement;
  const DARK = "dark";
  const LIGHT = "light";

  let _current = DARK;

  function _apply(theme) {
    _current = theme;
    ROOT.dataset.theme = theme;
    localStorage.setItem(STORAGE_KEY, theme);

    const iconMoon = document.getElementById("icon-moon");
    const iconSun = document.getElementById("icon-sun");
    if (iconMoon && iconSun) {
      if (theme === DARK) {
        iconMoon.style.display = "";
        iconSun.style.display = "none";
      } else {
        iconMoon.style.display = "none";
        iconSun.style.display = "";
      }
    }
  }

  function init() {
    const saved = localStorage.getItem(STORAGE_KEY);
    const preferred = window.matchMedia("(prefers-color-scheme: light)").matches
      ? LIGHT
      : DARK;
    _apply(saved || preferred);

    document.getElementById("theme-toggle")?.addEventListener("click", toggle);
  }

  function toggle() {
    _apply(_current === DARK ? LIGHT : DARK);
  }

  function current() {
    return _current;
  }

  return { init, toggle, current };
})();
