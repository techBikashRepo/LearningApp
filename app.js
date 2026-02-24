/**
 * app.js — Main Application Orchestrator
 * Loads curriculum.json, builds sidebar, handles routing,
 * renders lessons, manages all interactions.
 */

// ══════════════════════════════════════════════════════════════
//  State
// ══════════════════════════════════════════════════════════════

const App = {
  curriculum: null, // parsed curriculum.json
  flatLessons: [], // [{subjectId, chapterId, partNum, ...}] for prev/next
  currentRoute: null, // active route object
  sidebarOpen: true, // desktop sidebar state
  _retryRoute: null, // for retry on error
};

// ══════════════════════════════════════════════════════════════
//  DOM Shortcuts
// ══════════════════════════════════════════════════════════════

const $ = (id) => document.getElementById(id);
const SIDEBAR = () => $("sidebar");
const SIDEBAR_NAV = () => $("sidebar-nav");
const MAIN = () => $("main-content");
const WELCOME = () => $("welcome-screen");
const LESSON_CNT = () => $("lesson-container");
const LESSON_CONTENT = () => $("lesson-content");
const LESSON_TITLE = () => $("lesson-title");
const LESSON_SUBTTL = () => $("lesson-subtitle");
const LESSON_STAG = () => $("lesson-subject-tag");
const LESSON_PTAGS = () => $("lesson-part-tags");
const LOADER = () => $("loader");
const ERROR_STATE = () => $("error-state");
const BREADCRUMB = () => $("breadcrumb");
const SCROLL_TOP_BTN = () => $("scroll-top");
const SUBJECT_CARDS = () => $("subject-cards");
const PREV_BTN = () => $("prev-lesson");
const NEXT_BTN = () => $("next-lesson");
const PREV_TITLE = () => $("prev-lesson-title");
const NEXT_TITLE = () => $("next-lesson-title");
const READING_BAR = () => $("reading-progress");

// ══════════════════════════════════════════════════════════════
//  Bootstrap
// ══════════════════════════════════════════════════════════════

async function bootstrap() {
  // 1. Theme (before render to avoid flash)
  Theme.init();

  // 2. Load curriculum
  try {
    const res = await fetch("curriculum.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    App.curriculum = await res.json();
  } catch (e) {
    document.body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;
                  flex-direction:column;gap:16px;font-family:system-ui;color:#e6edf3;background:#0f1117;">
        <div style="font-size:2rem">⚠️</div>
        <h2>Could not load curriculum.json</h2>
        <p style="color:#8b949e;max-width:400px;text-align:center">
          Please open this site via a local server (e.g. VS Code Live Server).
          <br><br><strong>curriculum.json</strong> must be served over HTTP/HTTPS — 
          it cannot be loaded via the <em>file://</em> protocol.
        </p>
        <code style="background:#161b22;padding:8px 16px;border-radius:8px;font-size:0.85rem;color:#58a6ff">
          http://localhost:5500
        </code>
      </div>`;
    return;
  }

  // 3. Init modules
  MarkdownLoader.init();
  _buildFlatLessons();
  _buildSidebar();
  _buildWelcomeCards();

  // 4. Search
  Search.init(App.curriculum, (subjectId, chapterId, partNum) => {
    Router.navigate(subjectId, chapterId, partNum);
  });

  // 5. Router
  Router.onChange(_onRoute);
  Router.init();

  // 6. UI wiring
  _wireUI();
}

// ══════════════════════════════════════════════════════════════
//  Flat lesson list (for prev/next navigation)
// ══════════════════════════════════════════════════════════════

function _buildFlatLessons() {
  App.flatLessons = [];
  App.curriculum.subjects.forEach((subj) => {
    subj.chapters.forEach((ch) => {
      ch.parts.forEach((part) => {
        App.flatLessons.push({
          subjectId: subj.id,
          subjectTitle: subj.title,
          subjectIcon: subj.icon,
          chapterId: ch.id,
          chapterTitle: ch.title,
          partNum: part.num,
          subtitle: part.subtitle,
          file: part.file,
        });
      });
    });
  });
}

// ══════════════════════════════════════════════════════════════
//  Sidebar builder
// ══════════════════════════════════════════════════════════════

function _buildSidebar() {
  const nav = SIDEBAR_NAV();
  if (!nav || !App.curriculum) return;
  nav.innerHTML = "";

  App.curriculum.subjects.forEach((subj) => {
    const group = document.createElement("div");
    group.className = "subject-group";
    group.dataset.id = subj.id;

    // Subject header
    const header = document.createElement("div");
    header.className = "subject-header";
    header.dataset.subjectId = subj.id;
    header.innerHTML = `
      <span class="subject-icon" data-icon="${subj.icon}"></span>
      <span class="subject-title">${subj.title}</span>
      <span class="subject-chevron">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </span>`;

    // Chapter list
    const chList = document.createElement("div");
    chList.className = "chapter-list";

    subj.chapters.forEach((ch) => {
      const chItem = document.createElement("div");
      chItem.className = "chapter-item";
      chItem.dataset.chapterId = ch.id;

      const chHeader = document.createElement("div");
      chHeader.className = "chapter-header";
      chHeader.dataset.chapterId = ch.id;
      chHeader.innerHTML = `
        <span class="chapter-num">${String(ch.number).padStart(2, "0")}</span>
        <span class="chapter-title-text">${ch.title}</span>
        <span class="chapter-chevron">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </span>`;

      // Parts
      const partsList = document.createElement("div");
      partsList.className = "parts-list";

      ch.parts.forEach((part) => {
        const partEl = document.createElement("div");
        partEl.className = "part-item";
        partEl.dataset.subjectId = subj.id;
        partEl.dataset.chapterId = ch.id;
        partEl.dataset.partNum = part.num;
        partEl.innerHTML = `
          <span class="part-dot"></span>
          <span class="part-label">${part.subtitle}</span>
          <span class="part-num-badge">P${part.num}</span>`;

        partEl.addEventListener("click", () => {
          Router.navigate(subj.id, ch.id, part.num);
          // Close sidebar on mobile after selection
          if (window.innerWidth < 960) _closeSidebarMobile();
        });
        partsList.appendChild(partEl);
      });

      // Chapter click → toggle parts
      chHeader.addEventListener("click", () => {
        const isOpen = chHeader.classList.contains("is-open");
        // Close other chapters in same subject
        chList.querySelectorAll(".chapter-header.is-open").forEach((h) => {
          if (h !== chHeader) {
            h.classList.remove("is-open");
            h.nextElementSibling?.classList.remove("is-open");
          }
        });
        chHeader.classList.toggle("is-open", !isOpen);
        partsList.classList.toggle("is-open", !isOpen);
      });

      chItem.appendChild(chHeader);
      chItem.appendChild(partsList);
      chList.appendChild(chItem);
    });

    // Subject click → toggle chapter list
    header.addEventListener("click", () => {
      const isOpen = header.classList.contains("is-open");
      // Collapse all subjects first
      nav.querySelectorAll(".subject-header.is-open").forEach((h) => {
        if (h !== header) {
          h.classList.remove("is-open");
          h.nextElementSibling?.classList.remove("is-open");
        }
      });
      header.classList.toggle("is-open", !isOpen);
      chList.classList.toggle("is-open", !isOpen);
    });

    group.appendChild(header);
    group.appendChild(chList);
    nav.appendChild(group);
  });
}

// ══════════════════════════════════════════════════════════════
//  Welcome Screen Cards
// ══════════════════════════════════════════════════════════════

function _buildWelcomeCards() {
  const grid = SUBJECT_CARDS();
  if (!grid || !App.curriculum) return;
  grid.innerHTML = "";

  const iconMap = {
    network: "🌐",
    backend: "⚙️",
    security: "🔐",
    database: "🗄️",
    architecture: "🏗️",
  };

  App.curriculum.subjects.forEach((subj) => {
    const totalLessons = subj.chapters.reduce(
      (sum, ch) => sum + ch.parts.length,
      0,
    );
    const card = document.createElement("div");
    card.className = "subject-card";
    card.innerHTML = `
      <div class="subject-card-icon">${iconMap[subj.icon] || "📚"}</div>
      <div class="subject-card-title">${subj.title}</div>
      <div class="subject-card-count">${subj.chapters.length} chapters · ${totalLessons} lessons</div>`;

    card.addEventListener("click", () => {
      // Open the first chapter of this subject
      const firstCh = subj.chapters[0];
      const firstPart = firstCh?.parts[0];
      if (firstCh && firstPart) {
        Router.navigate(subj.id, firstCh.id, firstPart.num);
      }
    });
    grid.appendChild(card);
  });
}

// ══════════════════════════════════════════════════════════════
//  Routing Handler
// ══════════════════════════════════════════════════════════════

async function _onRoute(route) {
  App.currentRoute = route;

  if (route.type === "home") {
    _showWelcome();
    return;
  }

  if (route.type === "subject") {
    _showWelcome();
    _openSubjectInSidebar(route.subjectId);
    return;
  }

  if (route.type === "lesson") {
    await _loadLesson(route.subjectId, route.chapterId, route.partNum);
  }
}

async function _loadLesson(subjectId, chapterId, partNum) {
  const lesson = App.flatLessons.find(
    (l) =>
      l.subjectId === subjectId &&
      l.chapterId === chapterId &&
      l.partNum === partNum,
  );

  if (!lesson) {
    _showError(`Lesson not found: ${subjectId}/${chapterId}/part${partNum}`);
    return;
  }

  _showLoader();
  _updateSidebarActive(subjectId, chapterId, partNum);
  _updateBreadcrumb(lesson);
  _updateLessonHeader(lesson);
  _updatePrevNext(lesson);

  try {
    const { html, raw } = await MarkdownLoader.load(lesson.file);

    // Index content for search
    Search.indexContent(lesson.file, raw);

    _showLesson();
    MarkdownLoader.inject(html, LESSON_CONTENT());

    // Build TOC from rendered headings
    TOC.build(LESSON_CONTENT());

    // Scroll to top of content
    window.scrollTo({ top: 0, behavior: "instant" });

    // Update reading progress
    _updateProgress();
  } catch (err) {
    console.error("Failed to load lesson:", err);
    App._retryRoute = { subjectId, chapterId, partNum };
    _showError(err.message);
  }
}

// ══════════════════════════════════════════════════════════════
//  Lesson Header & Meta
// ══════════════════════════════════════════════════════════════

function _updateLessonHeader(lesson) {
  if (LESSON_TITLE()) LESSON_TITLE().textContent = lesson.chapterTitle;
  if (LESSON_SUBTTL())
    LESSON_SUBTTL().textContent = `Part ${lesson.partNum} of 3 — ${lesson.subtitle}`;

  // Subject tag
  const tagEl = LESSON_STAG();
  if (tagEl) {
    tagEl.textContent = lesson.subjectTitle;
    tagEl.className = "subject-tag " + _tagClass(lesson.subjectId);
  }

  // Part badges (Part 1 / Part 2 / Part 3)
  const ptags = LESSON_PTAGS();
  if (ptags && App.curriculum) {
    const subj = App.curriculum.subjects.find((s) => s.id === lesson.subjectId);
    const ch = subj?.chapters.find((c) => c.id === lesson.chapterId);
    if (ch) {
      ptags.innerHTML = ch.parts
        .map(
          (p) =>
            `<span class="part-badge ${p.num === lesson.partNum ? "is-active" : ""}" 
               style="cursor:pointer" 
               data-subjectid="${lesson.subjectId}" 
               data-chapterid="${lesson.chapterId}" 
               data-partnum="${p.num}">Part ${p.num}</span>`,
        )
        .join("");

      ptags.querySelectorAll(".part-badge").forEach((b) => {
        b.addEventListener("click", () => {
          Router.navigate(
            b.dataset.subjectid,
            b.dataset.chapterid,
            parseInt(b.dataset.partnum),
          );
        });
      });
    }
  }
}

function _tagClass(subjectId) {
  if (subjectId.includes("networking")) return "tag-networking";
  if (subjectId.includes("backend")) return "tag-backend";
  if (subjectId.includes("security")) return "tag-security";
  if (subjectId.includes("database")) return "tag-database";
  if (subjectId.includes("system-design")) return "tag-architecture";
  return "tag-networking";
}

// ══════════════════════════════════════════════════════════════
//  Prev / Next
// ══════════════════════════════════════════════════════════════

function _updatePrevNext(lesson) {
  const idx = App.flatLessons.indexOf(lesson);
  const prev = App.flatLessons[idx - 1] || null;
  const next = App.flatLessons[idx + 1] || null;

  const prevBtn = PREV_BTN();
  const nextBtn = NEXT_BTN();

  if (prevBtn) {
    prevBtn.disabled = !prev;
    if (prev) {
      PREV_TITLE().textContent = `${prev.chapterTitle} (P${prev.partNum})`;
      prevBtn.onclick = () =>
        Router.navigate(prev.subjectId, prev.chapterId, prev.partNum);
    } else {
      PREV_TITLE().textContent = "—";
      prevBtn.onclick = null;
    }
  }

  if (nextBtn) {
    nextBtn.disabled = !next;
    if (next) {
      NEXT_TITLE().textContent = `${next.chapterTitle} (P${next.partNum})`;
      nextBtn.onclick = () =>
        Router.navigate(next.subjectId, next.chapterId, next.partNum);
    } else {
      NEXT_TITLE().textContent = "—";
      nextBtn.onclick = null;
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  Breadcrumb
// ══════════════════════════════════════════════════════════════

function _updateBreadcrumb(lesson) {
  const bc = BREADCRUMB();
  if (!bc) return;
  bc.innerHTML = `
    <span class="breadcrumb-item" id="breadcrumb-subject">${lesson.subjectTitle}</span>
    <span class="breadcrumb-sep">›</span>
    <span class="breadcrumb-item">${lesson.chapterTitle}</span>
    <span class="breadcrumb-sep">›</span>
    <span class="breadcrumb-item">Part ${lesson.partNum}</span>`;
}

// ══════════════════════════════════════════════════════════════
//  Sidebar Active State
// ══════════════════════════════════════════════════════════════

function _updateSidebarActive(subjectId, chapterId, partNum) {
  const nav = SIDEBAR_NAV();
  if (!nav) return;

  // Deactivate all
  nav
    .querySelectorAll(".part-item.is-active")
    .forEach((el) => el.classList.remove("is-active"));
  nav
    .querySelectorAll(".chapter-header.has-active")
    .forEach((el) => el.classList.remove("has-active"));

  // Activate target
  const partEl =
    nav.querySelector(
      `.part-item[data-subject-id="${subjectId}"][data-chapter-id="${chapterId}"][data-part-num="${partNum}"]`,
    ) ||
    nav.querySelector(
      `.part-item[data-subjectid="${subjectId}"][data-chapterid="${chapterId}"][data-partnum="${partNum}"]`,
    );

  if (partEl) {
    partEl.classList.add("is-active");
    partEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // Open parent subject + chapter
  _openSubjectInSidebar(subjectId, chapterId);
}

function _openSubjectInSidebar(subjectId, chapterId) {
  const nav = SIDEBAR_NAV();
  if (!nav) return;

  // Open the subject
  const subjectHeader =
    nav.querySelector(`.subject-header[data-subject-id="${subjectId}"]`) ||
    nav.querySelector(`.subject-header[data-subjectid="${subjectId}"]`);

  if (subjectHeader && !subjectHeader.classList.contains("is-open")) {
    subjectHeader.classList.add("is-open");
    subjectHeader.nextElementSibling?.classList.add("is-open");
  }

  // Open the chapter
  if (chapterId) {
    const chHeader =
      nav.querySelector(`.chapter-header[data-chapter-id="${chapterId}"]`) ||
      nav.querySelector(`.chapter-header[data-chapterid="${chapterId}"]`);
    if (chHeader && !chHeader.classList.contains("is-open")) {
      chHeader.classList.add("is-open");
      chHeader.classList.add("has-active");
      chHeader.nextElementSibling?.classList.add("is-open");
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  View State Switchers
// ══════════════════════════════════════════════════════════════

function _showWelcome() {
  WELCOME()?.classList.remove("hidden");
  LESSON_CNT()?.classList.add("hidden");
  LOADER()?.classList.add("hidden");
  ERROR_STATE()?.classList.add("hidden");
  TOC.hide();
  BREADCRUMB().innerHTML = `<span class="breadcrumb-item" id="breadcrumb-home">Learning Portal</span>`;
}

function _showLoader() {
  WELCOME()?.classList.add("hidden");
  LESSON_CNT()?.classList.add("hidden");
  LOADER()?.classList.remove("hidden");
  ERROR_STATE()?.classList.add("hidden");
}

function _showLesson() {
  WELCOME()?.classList.add("hidden");
  LESSON_CNT()?.classList.remove("hidden");
  LOADER()?.classList.add("hidden");
  ERROR_STATE()?.classList.add("hidden");
  TOC.show();
}

function _showError(msg) {
  WELCOME()?.classList.add("hidden");
  LESSON_CNT()?.classList.add("hidden");
  LOADER()?.classList.add("hidden");
  ERROR_STATE()?.classList.remove("hidden");
  const msgEl = $("error-message");
  if (msgEl) msgEl.textContent = msg;
  TOC.hide();
}

// ══════════════════════════════════════════════════════════════
//  Reading Progress Bar
// ══════════════════════════════════════════════════════════════

function _updateProgress() {
  const bar = READING_BAR();
  if (!bar) return;

  function update() {
    const scrolled = window.scrollY;
    const total = document.documentElement.scrollHeight - window.innerHeight;
    const pct = total > 0 ? Math.min(100, (scrolled / total) * 100) : 0;
    bar.style.width = pct + "%";
  }

  window.addEventListener("scroll", update, { passive: true });
}

// ══════════════════════════════════════════════════════════════
//  UI Wiring
// ══════════════════════════════════════════════════════════════

function _wireUI() {
  // Sidebar toggle
  $("sidebar-toggle")?.addEventListener("click", _toggleSidebar);

  // Sidebar overlay click (mobile)
  $("sidebar-overlay")?.addEventListener("click", _closeSidebarMobile);

  // Site logo → home
  $("site-logo")?.addEventListener("click", (e) => {
    e.preventDefault();
    Router.navigateHome();
  });

  // Scroll to top button
  const topBtn = SCROLL_TOP_BTN();
  if (topBtn) {
    topBtn.addEventListener("click", () =>
      window.scrollTo({ top: 0, behavior: "smooth" }),
    );
    window.addEventListener(
      "scroll",
      () => {
        topBtn.classList.toggle("hidden", window.scrollY < 400);
      },
      { passive: true },
    );
  }

  // Error retry
  $("error-retry")?.addEventListener("click", () => {
    if (App._retryRoute) {
      const { subjectId, chapterId, partNum } = App._retryRoute;
      _loadLesson(subjectId, chapterId, partNum);
    }
  });

  // Keyboard shortcuts: ← → for prev/next lesson
  document.addEventListener("keydown", (e) => {
    // Skip if typing in input
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if (Search.isOpen?.()) return;

    if (e.key === "ArrowLeft" && !e.altKey) PREV_BTN()?.click();
    if (e.key === "ArrowRight" && !e.altKey) NEXT_BTN()?.click();
  });

  // Responsive: collapse sidebar on small screens by default
  if (window.innerWidth < 960) {
    SIDEBAR()?.classList.remove("is-open");
    App.sidebarOpen = false;
  }

  // Resize handler
  window.addEventListener("resize", _onResize, { passive: true });
}

function _toggleSidebar() {
  if (window.innerWidth < 960) {
    // Mobile: use is-open class
    SIDEBAR()?.classList.toggle("is-open");
  } else {
    // Desktop: use body class
    App.sidebarOpen = !App.sidebarOpen;
    document.body.classList.toggle("sidebar-collapsed", !App.sidebarOpen);
  }
}

function _closeSidebarMobile() {
  SIDEBAR()?.classList.remove("is-open");
}

function _onResize() {
  if (window.innerWidth >= 960) {
    SIDEBAR()?.classList.remove("is-open");
    if (App.sidebarOpen) document.body.classList.remove("sidebar-collapsed");
  }
}

// ══════════════════════════════════════════════════════════════
//  Start
// ══════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", bootstrap);
