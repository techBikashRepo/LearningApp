/**
 * markdownLoader.js — Fetches, parses, and caches Markdown files
 * Uses marked.js for MD→HTML conversion
 * Uses Prism.js for syntax highlighting after injection
 */

const MarkdownLoader = (() => {
  /** @type {Map<string, string>} url → rendered HTML */
  const _cache = new Map();

  /** @type {Map<string, string>} url → raw markdown text */
  const _rawCache = new Map();

  // Configure marked — minimal options only, no custom renderer
  // (avoids API version mismatches between marked.js releases)
  function _configureMarked() {
    if (typeof marked === "undefined") return;
    marked.use({ breaks: true, gfm: true });
  }

  /**
   * Post-process HTML output from marked.parse():
   *  - Add id="" anchors to all headings for TOC
   *  - Wrap <pre><code> blocks with copy button + lang label
   *  - Open external links in new tab
   * @param {string} html
   * @returns {string}
   */
  function _postProcess(html) {
    // Use a temporary div so we can manipulate real DOM nodes
    const tmp = document.createElement("div");
    tmp.innerHTML = html;

    // 1. Heading anchors
    tmp.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => {
      if (!h.id) {
        const id = h.textContent
          .toLowerCase()
          .replace(/[^\w\s-]/g, "")
          .replace(/\s+/g, "-")
          .replace(/-{2,}/g, "-")
          .trim()
          .substring(0, 80);
        h.id = id;
      }
    });

    // 2. Code blocks — add lang label + copy button
    tmp.querySelectorAll("pre > code").forEach((codeEl) => {
      const pre = codeEl.parentElement;
      // Detect language from class like "language-js"
      const langClass = Array.from(codeEl.classList).find((c) =>
        c.startsWith("language-"),
      );
      const lang = langClass ? langClass.replace("language-", "") : "";

      // Lang label
      if (lang && lang !== "text" && lang !== "plaintext") {
        const label = document.createElement("span");
        label.className = "code-lang-label";
        label.textContent = lang;
        pre.insertBefore(label, codeEl);
      }

      // Copy button — store raw text directly as a dataset attribute
      const btn = document.createElement("button");
      btn.className = "code-copy-btn";
      btn.textContent = "Copy";
      btn.dataset.code = codeEl.textContent;
      pre.insertBefore(btn, codeEl);
    });

    // 3. External links → open in new tab
    tmp.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") || "";
      if (href.startsWith("http://") || href.startsWith("https://")) {
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
    });

    return tmp.innerHTML;
  }

  /**
   * Fetch and render a markdown file.
   * @param {string} filePath  — relative path, e.g. "content/..."
   * @returns {Promise<{html: string, raw: string}>}
   */
  async function load(filePath) {
    if (_cache.has(filePath)) {
      return { html: _cache.get(filePath), raw: _rawCache.get(filePath) };
    }

    const response = await fetch(filePath);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${filePath}`);
    }

    const raw = await response.text();
    const rawHtml = marked.parse(raw);
    const html = _postProcess(rawHtml);
    _cache.set(filePath, html);
    _rawCache.set(filePath, raw);

    return { html, raw };
  }

  /**
   * Inject HTML into content area and run Prism + copy buttons
   * @param {string} html
   * @param {HTMLElement} container
   */
  function inject(html, container) {
    container.innerHTML = html;

    // Prism syntax highlighting
    if (typeof Prism !== "undefined") {
      Prism.highlightAllUnder(container);
    }

    // Code copy buttons
    container.querySelectorAll(".code-copy-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        // code is stored directly as text in dataset.code (set during post-processing)
        const code = btn.dataset.code || "";
        try {
          await navigator.clipboard.writeText(code);
          btn.textContent = "Copied!";
          btn.classList.add("copied");
          setTimeout(() => {
            btn.textContent = "Copy";
            btn.classList.remove("copied");
          }, 2000);
        } catch {
          btn.textContent = "Error";
          setTimeout(() => {
            btn.textContent = "Copy";
          }, 1500);
        }
      });
    });

    // Make images lazy load
    container.querySelectorAll("img").forEach((img) => {
      img.loading = "lazy";
    });
  }

  /**
   * Get raw markdown from cache (for search indexing)
   * @param {string} filePath
   * @returns {string|null}
   */
  function getRaw(filePath) {
    return _rawCache.get(filePath) || null;
  }

  /**
   * Check if a file is already cached
   * @param {string} filePath
   */
  function isCached(filePath) {
    return _cache.has(filePath);
  }

  function init() {
    _configureMarked();
  }

  return { init, load, inject, getRaw, isCached };
})();
