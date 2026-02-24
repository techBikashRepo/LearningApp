/**
 * search.js — Client-side full-text search
 * Indexes lesson titles + chapter titles from curriculum.json immediately.
 * Indexes raw markdown content lazily as lessons are loaded.
 * Searches synchronously against the index — no external APIs.
 */

const Search = (() => {
  /** @type {Array<{subjectId, subjectTitle, chapterId, chapterTitle, partNum, subtitle, file, text}>} */
  let _index = [];
  let _curriculum = null;
  let _onNavigate = null;
  let _focusIdx = -1;
  let _results = [];

  const overlay = () => document.getElementById("search-overlay");
  const modal = () => document.getElementById("search-modal");
  const input = () => document.getElementById("search-input");
  const resultsEl = () => document.getElementById("search-results");
  const emptyEl = () => document.getElementById("search-empty");
  const hintEl = () => document.getElementById("search-hint");
  const searchBtn = () => document.getElementById("search-btn");

  /**
   * Build initial index from curriculum (titles only)
   * @param {Object} curriculum
   * @param {Function} onNavigate  — callback(subjectId, chapterId, partNum)
   */
  function init(curriculum, onNavigate) {
    _curriculum = curriculum;
    _onNavigate = onNavigate;
    _buildTitleIndex();

    // UI events
    searchBtn()?.addEventListener("click", open);
    overlay()?.addEventListener("click", (e) => {
      if (e.target === overlay()) close();
    });
    input()?.addEventListener("input", _onInput);
    input()?.addEventListener("keydown", _onKeydown);

    // Global keyboard shortcut Ctrl+K / Cmd+K
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        isOpen() ? close() : open();
      }
      if (e.key === "Escape" && isOpen()) close();
    });
  }

  function _buildTitleIndex() {
    if (!_curriculum) return;
    _curriculum.subjects.forEach((subj) => {
      subj.chapters.forEach((ch) => {
        ch.parts.forEach((part) => {
          _index.push({
            subjectId: subj.id,
            subjectTitle: subj.title,
            chapterId: ch.id,
            chapterTitle: ch.title,
            partNum: part.num,
            subtitle: part.subtitle,
            file: part.file,
            text: [subj.title, ch.title, part.subtitle].join(" ").toLowerCase(),
            raw: null, // loaded on demand
          });
        });
      });
    });
  }

  /**
   * Add raw markdown content for a lesson (called after it's loaded)
   * @param {string} file  — relative file path
   * @param {string} rawMd — raw markdown text
   */
  function indexContent(file, rawMd) {
    const entry = _index.find((e) => e.file === file);
    if (entry && !entry.raw) {
      // Strip markdown syntax for clean text search
      const clean = rawMd
        .replace(/```[\s\S]*?```/g, " ") // code blocks
        .replace(/`[^`]+`/g, " ") // inline code
        .replace(/#{1,6}\s/g, " ") // headings
        .replace(/[*_~[\]()#>|!]/g, " ") // markdown chars
        .replace(/\s{2,}/g, " ")
        .toLowerCase();
      entry.raw = clean;
      entry.text = (entry.text + " " + clean).slice(0, 4000);
    }
  }

  function _query(q) {
    if (!q || q.length < 2) return [];
    const terms = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const scored = [];

    _index.forEach((entry) => {
      let score = 0;
      const titleStr = [entry.chapterTitle, entry.subtitle]
        .join(" ")
        .toLowerCase();
      const fullStr = entry.text;

      terms.forEach((term) => {
        if (titleStr.includes(term)) score += 10;
        else if (fullStr.includes(term)) score += 1;
      });

      if (score > 0) scored.push({ entry, score });
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((s) => s.entry);
  }

  function _highlight(text, query) {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    let result = text;
    terms.forEach((term) => {
      const re = new RegExp(`(${_escapeRegex(term)})`, "gi");
      result = result.replace(re, "<mark>$1</mark>");
    });
    return result;
  }

  function _escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function _renderResults(q) {
    const res = _query(q);
    _results = res;
    _focusIdx = -1;
    const el = resultsEl();
    if (!el) return;

    el.innerHTML = "";

    if (!q || q.length < 2) {
      emptyEl()?.classList.add("hidden");
      hintEl()?.classList.remove("hidden");
      return;
    }

    hintEl()?.classList.add("hidden");

    if (res.length === 0) {
      emptyEl()?.classList.remove("hidden");
      return;
    }

    emptyEl()?.classList.add("hidden");

    res.forEach((entry, i) => {
      const item = document.createElement("div");
      item.className = "search-result-item";
      item.role = "option";
      item.dataset.idx = i;

      const titleHighlighted = _highlight(entry.chapterTitle, q);
      const subjHighlighted = _highlight(entry.subjectTitle, q);
      const subHighlighted = _highlight(entry.subtitle, q);

      // Show a snippet from raw content if available
      let excerpt = "";
      if (entry.raw) {
        const idx = entry.raw.indexOf(q.toLowerCase().split(" ")[0]);
        if (idx > -1) {
          excerpt = entry.raw
            .substring(Math.max(0, idx - 30), idx + 100)
            .trim();
          excerpt = _highlight(excerpt, q);
        }
      }

      item.innerHTML = `
        <span class="search-result-title">${titleHighlighted}</span>
        <span class="search-result-meta">${subjHighlighted} · Part ${entry.partNum}: ${subHighlighted}</span>
        ${excerpt ? `<span class="search-result-excerpt">${excerpt}</span>` : ""}
      `;

      item.addEventListener("click", () => _select(entry));
      el.appendChild(item);
    });
  }

  function _select(entry) {
    close();
    if (_onNavigate) {
      _onNavigate(entry.subjectId, entry.chapterId, entry.partNum);
    }
  }

  function _onInput(e) {
    _renderResults(e.target.value);
  }

  function _onKeydown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      _focusIdx = Math.min(_focusIdx + 1, _results.length - 1);
      _updateFocus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      _focusIdx = Math.max(_focusIdx - 1, -1);
      _updateFocus();
    } else if (e.key === "Enter") {
      if (_focusIdx >= 0 && _results[_focusIdx]) {
        _select(_results[_focusIdx]);
      }
    }
  }

  function _updateFocus() {
    const items = resultsEl()?.querySelectorAll(".search-result-item");
    if (!items) return;
    items.forEach((item, i) => {
      item.classList.toggle("is-focused", i === _focusIdx);
      if (i === _focusIdx) item.scrollIntoView({ block: "nearest" });
    });
  }

  function open() {
    overlay()?.classList.remove("hidden");
    const inp = input();
    if (inp) {
      setTimeout(() => inp.focus(), 50);
      if (inp.value) _renderResults(inp.value);
      else {
        hintEl()?.classList.remove("hidden");
        emptyEl()?.classList.add("hidden");
      }
    }
  }

  function close() {
    overlay()?.classList.add("hidden");
  }

  function isOpen() {
    return !overlay()?.classList.contains("hidden");
  }

  return { init, indexContent, open, close, isOpen };
})();
