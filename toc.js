/**
 * toc.js — Auto Table of Contents + Scroll Spy
 * Reads h1/h2/h3 from rendered content, builds TOC nav,
 * highlights current heading while reading
 */

const TOC = (() => {
  let _observer = null;
  let _tocItems = [];
  let _activeId = null;
  const TOC_NAV = () => document.getElementById("toc-nav");
  const TOC_SIDEBAR = () => document.getElementById("toc-sidebar");

  /**
   * Build TOC from headings inside the content container
   * @param {HTMLElement} contentEl  — the .markdown-body element
   */
  function build(contentEl) {
    _destroy();

    const tocNav = TOC_NAV();
    if (!tocNav) return;

    const headings = Array.from(contentEl.querySelectorAll("h1, h2, h3"));
    if (headings.length === 0) {
      tocNav.innerHTML = '<p class="toc-empty">No sections</p>';
      return;
    }

    tocNav.innerHTML = "";
    _tocItems = [];

    headings.forEach((h) => {
      const depth = parseInt(h.tagName[1], 10);
      const id = h.id || _makeId(h.textContent);
      if (!h.id) h.id = id;

      const link = document.createElement("a");
      link.className = "toc-item";
      link.dataset.depth = depth;
      link.dataset.id = id;
      link.href = `#${id}`;
      link.textContent = h.textContent;
      link.title = h.textContent;

      link.addEventListener("click", (e) => {
        e.preventDefault();
        const target = document.getElementById(id);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });

      tocNav.appendChild(link);
      _tocItems.push({ id, el: h, link });
    });

    _startScrollSpy(contentEl);
  }

  function _makeId(text) {
    return text
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-{2,}/g, "-")
      .trim()
      .substring(0, 64);
  }

  function _startScrollSpy() {
    if (_observer) _observer.disconnect();

    const options = {
      root: null,
      rootMargin: "-64px 0px -60% 0px",
      threshold: 0,
    };

    _observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          _setActive(entry.target.id);
        }
      });
    }, options);

    _tocItems.forEach((item) => _observer.observe(item.el));
  }

  function _setActive(id) {
    if (_activeId === id) return;
    _activeId = id;
    _tocItems.forEach((item) => {
      item.link.classList.toggle("is-active", item.id === id);
    });
    // Scroll active TOC item into view within sidebar
    const active = _tocItems.find((i) => i.id === id);
    if (active) {
      active.link.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  function _destroy() {
    if (_observer) {
      _observer.disconnect();
      _observer = null;
    }
    _tocItems = [];
    _activeId = null;
  }

  function clear() {
    _destroy();
    const tocNav = TOC_NAV();
    if (tocNav) tocNav.innerHTML = "";
  }

  function show() {
    const s = TOC_SIDEBAR();
    if (s) s.style.display = "";
  }

  function hide() {
    const s = TOC_SIDEBAR();
    if (s) s.style.display = "none";
  }

  return { build, clear, show, hide };
})();
