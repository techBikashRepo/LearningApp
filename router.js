/**
 * router.js — Hash-based routing
 * URL format: #subjectId/chapterId/partNum
 * e.g.  #01-networking/01-what-is-a-network/1
 *
 * Routes:
 *   (empty)    → welcome screen
 *   #subject   → scroll subject open (welcome)
 *   #s/c/p     → load lesson
 */

const Router = (() => {
  const listeners = [];

  function _parse(hash) {
    const h = (hash || "").replace(/^#/, "").trim();
    if (!h) return { type: "home" };

    const parts = h.split("/");
    if (parts.length === 1) return { type: "subject", subjectId: parts[0] };
    if (parts.length >= 3) {
      return {
        type: "lesson",
        subjectId: parts[0],
        chapterId: parts[1],
        partNum: parseInt(parts[2], 10) || 1,
      };
    }
    return { type: "home" };
  }

  function _dispatch() {
    const route = _parse(window.location.hash);
    listeners.forEach((fn) => fn(route));
  }

  function init() {
    window.addEventListener("hashchange", _dispatch);
    // Initial dispatch
    _dispatch();
  }

  function navigate(subjectId, chapterId, partNum) {
    const hash = chapterId
      ? `#${subjectId}/${chapterId}/${partNum || 1}`
      : `#${subjectId}`;
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    } else {
      // Same route – still dispatch (e.g., after reload)
      _dispatch();
    }
  }

  function navigateHome() {
    if (window.location.hash !== "") {
      window.history.pushState("", document.title, window.location.pathname);
      _dispatch();
    }
  }

  function onChange(fn) {
    listeners.push(fn);
  }

  function current() {
    return _parse(window.location.hash);
  }

  return { init, navigate, navigateHome, onChange, current };
})();
