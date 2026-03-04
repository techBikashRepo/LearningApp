/**
 * lms.js — Learning Management System
 * Dashboard · Daily Planner · Heatmap · Progress Tracking
 * Requires: lms-topics.js (loaded before this file)
 */

const LMS = (() => {
  // ── Constants ───────────────────────────────────────────────
  const STORAGE_KEY = "lms_v2";
  const TOTAL_TOPICS = LMS_TOPICS.length; // 127
  const TOTAL_DAYS = TOTAL_TOPICS; // 1 topic per day

  const STATUS_LABELS = {
    "not-started": "Not Started",
    learning: "Learning",
    completed: "Completed",
  };

  // Daily study: 06:30–08:00
  const SCHEDULE = {
    morning: { label: "6:30 AM – 8:00 AM", cls: "morning" },
  };

  // ── State (loaded from / saved to localStorage) ─────────────
  let state = null;

  // ── Helpers ─────────────────────────────────────────────────
  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  function addDays(dateStr, n) {
    const d = new Date(dateStr + "T00:00:00");
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function formatDate(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function formatDateShort(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function formatDayOfWeek(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-US", { weekday: "short" });
  }

  // ── Load & Save ─────────────────────────────────────────────
  function loadState() {
    // Try current key first
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        state = JSON.parse(raw);
        _ensurePlanRows();
        return;
      }
    } catch (_) {}

    // Migrate from lms_v1 (2-topics/day format) if it exists
    try {
      const oldRaw = localStorage.getItem("lms_v1");
      if (oldRaw) {
        const old = JSON.parse(oldRaw);
        state = { startDate: old.startDate || "2026-03-04", plans: [] };
        // Old format: day d had morningTopicId=d*2, eveningTopicId=d*2+1
        // New format: day N has morningTopicId=N (one topic per day)
        if (Array.isArray(old.plans)) {
          for (const op of old.plans) {
            if (!op) continue;
            // Migrate morning slot
            if (op.morningTopicId != null) {
              state.plans[op.morningTopicId] = {
                morningTopicId: op.morningTopicId,
                morningStatus: op.morningStatus || "not-started",
                notes: op.notes || "",
              };
            }
            // Migrate evening slot
            if (op.eveningTopicId != null) {
              state.plans[op.eveningTopicId] = {
                morningTopicId: op.eveningTopicId,
                morningStatus: op.eveningStatus || "not-started",
                notes: "",
              };
            }
          }
        }
        _ensurePlanRows();
        // Save under new key and remove old one
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        localStorage.removeItem("lms_v1");
        return;
      }
    } catch (_) {}

    // Fresh state
    state = {
      startDate: "2026-03-04",
      plans: [],
    };
    _ensurePlanRows();
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    _showToast("Progress saved ✓");
  }

  // Silent save — no toast (used for auto-save on page hide / unload)
  function _silentSave() {
    if (state) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function _ensurePlanRows() {
    if (!Array.isArray(state.plans)) state.plans = [];

    for (let day = 0; day < TOTAL_DAYS; day++) {
      // Only fill in truly missing/invalid rows — never overwrite valid saved data
      const existing = state.plans[day];
      if (!existing || typeof existing !== "object") {
        state.plans[day] = {
          morningTopicId: day < TOTAL_TOPICS ? day : null,
          morningStatus: "not-started",
          notes: "",
        };
      } else {
        // Ensure required fields exist on migrated/partial rows
        if (existing.morningTopicId === undefined)
          existing.morningTopicId = day;
        if (!existing.morningStatus) existing.morningStatus = "not-started";
        if (existing.notes === undefined) existing.notes = "";
      }
    }
  }

  // ── Stats Calculator ────────────────────────────────────────
  function getStats() {
    let completedTopics = 0;
    let completedDays = 0;

    for (let day = 0; day < TOTAL_DAYS; day++) {
      const p = state.plans[day];
      const mDone = p.morningStatus === "completed";
      if (mDone) {
        completedTopics++;
        completedDays++;
      }
    }

    const remaining = TOTAL_TOPICS - completedTopics;
    const pct = Math.round((completedTopics / TOTAL_TOPICS) * 100);
    const daysLeft = remaining;

    // Days studies so far (from start date to today)
    const today = todayStr();
    const start = state.startDate;
    const msPerDay = 86400000;
    const daysElapsed = Math.max(
      0,
      Math.floor(
        (new Date(today + "T00:00:00") - new Date(start + "T00:00:00")) /
          msPerDay,
      ) + 1,
    );

    // Current streak: consecutive days with at least 1 completed topic ending today
    let streak = 0;
    let checkDay = today;
    for (let i = 0; i < TOTAL_DAYS; i++) {
      const dayOffset = Math.floor(
        (new Date(checkDay + "T00:00:00") - new Date(start + "T00:00:00")) /
          msPerDay,
      );
      if (dayOffset < 0 || dayOffset >= TOTAL_DAYS) break;
      const p = state.plans[dayOffset];
      const mDone = p.morningStatus === "completed";
      if (!mDone) break;
      streak++;
      checkDay = addDays(start, dayOffset - 1);
    }

    // Best streak
    let bestStreak = 0,
      cur = 0;
    for (let day = 0; day < TOTAL_DAYS; day++) {
      const p = state.plans[day];
      if (p.morningStatus === "completed") {
        cur++;
        bestStreak = Math.max(bestStreak, cur);
      } else cur = 0;
    }

    // Subject-level progress
    const subjects = {};
    for (const t of LMS_TOPICS) {
      if (!subjects[t.subject]) subjects[t.subject] = { total: 0, done: 0 };
      subjects[t.subject].total++;
    }
    for (let day = 0; day < TOTAL_DAYS; day++) {
      const p = state.plans[day];
      if (p.morningTopicId !== null && p.morningStatus === "completed") {
        const t = LMS_TOPICS[p.morningTopicId];
        if (t) subjects[t.subject].done++;
      }
    }

    return {
      completedTopics,
      remaining,
      pct,
      daysLeft,
      completedDays,
      daysElapsed,
      streak,
      bestStreak,
      subjects,
    };
  }

  // ── DOM Helpers ─────────────────────────────────────────────
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function _showToast(msg) {
    const t = document.getElementById("lms-save-toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("visible");
    clearTimeout(t._tid);
    t._tid = setTimeout(() => t.classList.remove("visible"), 2000);
  }

  // ── Render Dashboard ────────────────────────────────────────
  function renderDashboard() {
    const s = getStats();

    // Stat cards
    const cards = [
      {
        cls: "card-total",
        label: "Total Topics",
        value: TOTAL_TOPICS,
        sub: `across ${TOTAL_DAYS} study days`,
      },
      {
        cls: "card-completed",
        label: "Completed",
        value: s.completedTopics,
        sub: `${s.completedDays} days fully done`,
      },
      {
        cls: "card-remaining",
        label: "Remaining",
        value: s.remaining,
        sub: `topics left to study`,
      },
      {
        cls: "card-percent",
        label: "Progress",
        value: `${s.pct}%`,
        sub: `of full roadmap`,
      },
      {
        cls: "card-days-done",
        label: "Days Elapsed",
        value: s.daysElapsed,
        sub: `since ${formatDateShort(state.startDate)}`,
      },
      {
        cls: "card-days-left",
        label: "Est. Days Left",
        value: s.daysLeft,
        sub: `at 1 topic/day`,
      },
    ];

    const grid = document.getElementById("lms-dashboard-grid");
    if (!grid) return;
    grid.innerHTML = "";
    for (const c of cards) {
      grid.insertAdjacentHTML(
        "beforeend",
        `
        <div class="lms-stat-card ${c.cls}">
          <div class="lms-stat-label">${c.label}</div>
          <div class="lms-stat-value">${c.value}</div>
          <div class="lms-stat-sub">${c.sub}</div>
        </div>
      `,
      );
    }

    // Big progress bar
    const fill = document.getElementById("lms-main-fill");
    const pctEl = document.getElementById("lms-main-pct");
    const subEl = document.getElementById("lms-progress-sub");
    if (fill) fill.style.width = s.pct + "%";
    if (pctEl) pctEl.textContent = s.pct + "%";
    if (subEl)
      subEl.textContent = `${s.completedTopics} of ${TOTAL_TOPICS} topics completed · ${s.remaining} remaining · ~${s.daysLeft} days to finish (1/day)`;
    // Per-subject bars
    const subjBars = document.getElementById("lms-subject-bars");
    if (subjBars) {
      subjBars.innerHTML = "";
      for (const [name, d] of Object.entries(s.subjects)) {
        const pct2 = Math.round((d.done / d.total) * 100);
        subjBars.insertAdjacentHTML(
          "beforeend",
          `
          <div class="lms-subject-bar-row">
            <div class="lms-subject-bar-label" title="${name}">${name}</div>
            <div class="lms-subject-bar-track">
              <div class="lms-subject-bar-fill" style="width:${pct2}%"></div>
            </div>
            <div class="lms-subject-bar-count">${d.done}/${d.total}</div>
          </div>
        `,
        );
      }
    }

    // Streaks
    const strEl = document.getElementById("lms-streak-val");
    const bstEl = document.getElementById("lms-best-streak-val");
    if (strEl) strEl.textContent = s.streak;
    if (bstEl) bstEl.textContent = s.bestStreak;
  }

  // ── Render Heatmap ──────────────────────────────────────────
  function renderHeatmap() {
    const container = document.getElementById("lms-heatmap-weeks");
    const monthsBar = document.getElementById("lms-heatmap-months");
    if (!container) return;
    container.innerHTML = "";
    if (monthsBar) monthsBar.innerHTML = "";

    // Build a lookup: dateStr → completedCount (0, 1, 2)
    const lookup = {};
    for (let day = 0; day < TOTAL_DAYS; day++) {
      const dateStr = addDays(state.startDate, day);
      const p = state.plans[day];
      let cnt = 0;
      if (p.morningStatus === "completed") cnt = 1;
      lookup[dateStr] = cnt;
    }

    // 16 weeks back from today → today
    const today = todayStr();
    const totalWeeks = 16;
    const totalCells = totalWeeks * 7;

    // Start: totalCells-1 days ago, aligned to Sunday
    const todayDate = new Date(today + "T00:00:00");
    const startOffset = totalWeeks * 7 - 1;
    let startDate = new Date(todayDate);
    startDate.setDate(startDate.getDate() - startOffset);
    // Align to Sunday
    const dow = startDate.getDay(); // 0=Sun
    startDate.setDate(startDate.getDate() - dow);

    // Build columns (weeks)
    const weeks = [];
    const monthPositions = [];
    let curMonth = null;

    for (let w = 0; w < totalWeeks + 1; w++) {
      const weekCells = [];
      for (let d = 0; d < 7; d++) {
        const cellDate = new Date(startDate);
        cellDate.setDate(startDate.getDate() + w * 7 + d);
        const cellStr = cellDate.toISOString().slice(0, 10);

        // Track month label positions
        const month = cellDate.toLocaleDateString("en-US", { month: "short" });
        if (d === 0 && month !== curMonth) {
          curMonth = month;
          monthPositions.push({ week: w, label: month });
        }

        const isFuture = cellStr > today;
        const isOutOfRange =
          cellStr < state.startDate ||
          cellStr > addDays(state.startDate, TOTAL_DAYS - 1);
        const count = lookup[cellStr] !== undefined ? lookup[cellStr] : 0;
        const label = isOutOfRange
          ? formatDateShort(cellStr)
          : `${formatDate(cellStr)}: ${count === 0 ? "No study" : "1 topic done ✓"}`;

        weekCells.push({ cellStr, count, isFuture, isOutOfRange, label });
      }
      weeks.push(weekCells);
    }

    // Month labels
    if (monthsBar) {
      monthsBar.style.display = "flex";
      monthsBar.style.paddingLeft = "30px";
      monthsBar.style.gap = "0";
      const cellW = 15; // 12px + 3px gap
      monthsBar.innerHTML = "";
      let prev = 0;
      for (const mp of monthPositions) {
        const spacer = el("span", "lms-heatmap-month-label");
        spacer.style.width = (mp.week - prev) * cellW + "px";
        spacer.style.minWidth = (mp.week - prev) * cellW + "px";
        spacer.textContent = mp.label;
        monthsBar.appendChild(spacer);
        prev = mp.week;
      }
    }

    // Day-of-week labels (left column)
    const leftLabels = ["", "Mon", "", "Wed", "", "Fri", ""];

    // Build week columns
    for (let w = 0; w < weeks.length; w++) {
      const col = el("div", "lms-heatmap-col");
      for (let d = 0; d < 7; d++) {
        const { cellStr, count, isFuture, isOutOfRange, label } = weeks[w][d];
        const cell = el("div", "lms-heatmap-cell");
        if (isFuture || isOutOfRange) {
          if (isFuture) cell.setAttribute("data-future", "true");
        } else {
          cell.setAttribute("data-count", count);
        }
        cell.setAttribute("data-tooltip", label);
        col.appendChild(cell);
      }
      container.appendChild(col);
    }

    // Wrap in rows for day-of-week labels
    // Rebuild using row approach instead
    container.innerHTML = "";

    const weeksGrid = el("div", "lms-heatmap-weeks-inner");
    weeksGrid.style.display = "flex";
    weeksGrid.style.gap = "3px";

    // Day labels on left
    const dayLabels = el("div", "lms-heatmap-col");
    dayLabels.style.gap = "3px";
    dayLabels.style.display = "flex";
    dayLabels.style.flexDirection = "column";
    ["", "Mon", "", "Wed", "", "Fri", ""].forEach((lbl) => {
      const span = el("div", "lms-heatmap-day-label");
      span.textContent = lbl;
      dayLabels.appendChild(span);
    });
    container.appendChild(dayLabels);

    for (let w = 0; w < weeks.length; w++) {
      const col = el("div", "lms-heatmap-col");
      for (let d = 0; d < 7; d++) {
        const { cellStr, count, isFuture, isOutOfRange, label } = weeks[w][d];
        const cell = el("div", "lms-heatmap-cell");
        if (isFuture || isOutOfRange) {
          if (isFuture) cell.setAttribute("data-future", "true");
        } else {
          cell.setAttribute("data-count", count);
        }
        cell.setAttribute("data-tooltip", label);
        col.appendChild(cell);
      }
      container.appendChild(col);
    }
  }

  // ── Render Planner ──────────────────────────────────────────
  function renderPlanner(filterStatus = "all") {
    const tbody = document.getElementById("lms-planner-tbody");
    if (!tbody) return;
    tbody.innerHTML = "";

    const today = todayStr();
    let todayRowRef = null;

    for (let day = 0; day < TOTAL_DAYS; day++) {
      const dateStr = addDays(state.startDate, day);
      const p = state.plans[day];
      const isToday = dateStr === today;
      const bothDone = p.morningStatus === "completed";

      // Filter
      if (filterStatus !== "all") {
        if (p.morningStatus !== filterStatus) continue;
      }

      // Completion fraction
      const doneCount = p.morningStatus === "completed" ? 1 : 0;
      const totalCount = 1;
      const rowPct = doneCount * 100;

      const tr = document.createElement("tr");
      tr.dataset.day = day;
      if (isToday) tr.classList.add("row-today");
      if (bothDone) tr.classList.add("row-completed-both");

      // Day cell
      const dayTd = el("td", "lms-day-cell");
      dayTd.innerHTML = `
        <div class="lms-day-num">Day ${day + 1}</div>
        <div class="lms-day-date">${formatDayOfWeek(dateStr)}, ${formatDateShort(dateStr)}${isToday ? '<span class="lms-today-badge">Today</span>' : ""}</div>
      `;
      tr.appendChild(dayTd);

      // Topic cell
      tr.appendChild(
        _topicCell(day, "morning", p.morningTopicId, p.morningStatus),
      );

      // Progress cell
      const progTd = el("td", "lms-progress-cell");
      progTd.innerHTML = `
        <div class="lms-row-prog-bar">
          <div class="lms-row-prog-fill" style="width:${rowPct}%"></div>
        </div>
        <div class="lms-row-prog-label">${doneCount}/${totalCount} done</div>
      `;
      tr.appendChild(progTd);

      // Notes cell
      const notesTd = el("td", "lms-notes-cell");
      const textarea = el("textarea", "lms-notes-input");
      textarea.placeholder = "Notes...";
      textarea.value = p.notes || "";
      textarea.rows = 1;
      textarea.addEventListener("change", (e) => {
        state.plans[day].notes = e.target.value;
        saveState();
      });
      notesTd.appendChild(textarea);
      tr.appendChild(notesTd);

      tbody.appendChild(tr);
      if (isToday) todayRowRef = tr;
    }

    // If no rows matched filter
    if (tbody.children.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="lms-table-empty">No entries match this filter.</td></tr>`;
    }

    // Scroll to today
    if (todayRowRef) {
      setTimeout(() => {
        todayRowRef.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 150);
    }
  }

  function _topicCell(day, session, topicId, status) {
    const td = el("td", "lms-topic-cell");
    const wrap = el("div", "lms-topic-wrap");

    // Time label
    const sch = session === "morning" ? SCHEDULE.morning : SCHEDULE.evening;
    wrap.insertAdjacentHTML(
      "beforeend",
      `
      <div class="lms-topic-time">
        <span class="lms-time-dot ${sch.cls}"></span>
        ${sch.label}
      </div>
    `,
    );

    if (topicId === null) {
      const na = el("div", "");
      na.style.cssText =
        "font-size:0.75rem;color:var(--text-muted);padding:4px 0";
      na.textContent = "—";
      wrap.appendChild(na);
      td.appendChild(wrap);
      return td;
    }

    // Topic dropdown
    const select = el("select", "lms-topic-select");
    for (const t of LMS_TOPICS) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = `[${t.subject}] ${t.title}`;
      if (t.id === topicId) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", (e) => {
      const key = session === "morning" ? "morningTopicId" : "eveningTopicId";
      state.plans[day][key] = parseInt(e.target.value);
      saveState();
    });
    wrap.appendChild(select);

    // Status dropdown
    const stSelect = el("select", `lms-status-select status-${status}`);
    for (const [val, lbl] of Object.entries(STATUS_LABELS)) {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = lbl;
      if (val === status) opt.selected = true;
      stSelect.appendChild(opt);
    }
    stSelect.addEventListener("change", (e) => {
      const key = session === "morning" ? "morningStatus" : "eveningStatus";
      state.plans[day][key] = e.target.value;
      // Update class
      stSelect.className = `lms-status-select status-${e.target.value}`;
      saveState();
      renderDashboard();
      renderHeatmap();
      // Update row progress bar
      const tr = stSelect.closest("tr");
      if (tr) _refreshRowProgress(tr, day);
    });
    wrap.appendChild(stSelect);

    td.appendChild(wrap);
    return td;
  }

  function _refreshRowProgress(tr, day) {
    const p = state.plans[day];
    const done = p.morningStatus === "completed";
    const fillEl = tr.querySelector(".lms-row-prog-fill");
    const lblEl = tr.querySelector(".lms-row-prog-label");
    if (fillEl) fillEl.style.width = done ? "100%" : "0%";
    if (lblEl) lblEl.textContent = done ? "1/1 done" : "0/1 done";
    tr.classList.toggle("row-completed-both", done);
  }

  // ── Show / Hide LMS Screen ───────────────────────────────────
  function showLMS() {
    // Hide app views
    const ids = ["welcome-screen", "lesson-container", "loader", "error-state"];
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.add("hidden");
    });

    // Hide TOC sidebar
    const toc = document.getElementById("toc-sidebar");
    if (toc) toc.style.display = "none";

    // Show LMS
    const screen = document.getElementById("lms-screen");
    if (screen) screen.classList.remove("hidden");

    // Render everything
    _syncStartDate();
    renderDashboard();
    renderHeatmap();
    renderPlanner();

    // Update breadcrumb
    const bc = document.getElementById("breadcrumb-subject");
    if (bc) bc.textContent = "📊 Learning Management System";

    // Scroll to top
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function hideLMS() {
    const screen = document.getElementById("lms-screen");
    if (screen) screen.classList.add("hidden");

    // Restore TOC sidebar
    const toc = document.getElementById("toc-sidebar");
    if (toc) toc.style.display = "";

    // Show welcome screen
    const welcome = document.getElementById("welcome-screen");
    if (welcome) welcome.classList.remove("hidden");

    // Restore breadcrumb
    const bc = document.getElementById("breadcrumb-subject");
    if (bc) bc.textContent = "Learning Portal";
  }

  function _syncStartDate() {
    const input = document.getElementById("lms-start-date");
    if (input) input.value = state.startDate;

    const infoEl = document.getElementById("lms-config-info");
    if (infoEl) {
      const endDate = addDays(state.startDate, TOTAL_DAYS - 1);
      infoEl.innerHTML = `<strong>${TOTAL_DAYS} study days</strong> · ${formatDateShort(state.startDate)} → ${formatDateShort(endDate)} · <strong>${TOTAL_TOPICS}</strong> topics total`;
    }
  }

  // ── Init ────────────────────────────────────────────────────
  function init() {
    loadState();
    _buildHTML();
    _attachEvents();
  }

  // ── Build HTML into the page ─────────────────────────────────
  function _buildHTML() {
    // 1. LMS nav button in header-right (before theme toggle)
    const headerRight = document.querySelector(".header-right");
    if (headerRight && !document.getElementById("lms-nav-btn")) {
      const btn = document.createElement("button");
      btn.id = "lms-nav-btn";
      btn.setAttribute("aria-label", "Learning Management System");
      btn.title = "Learning Management System (Ctrl+L)";
      btn.innerHTML = `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 10v6M2 10l10-5 10 5-10 5z"/>
          <path d="M6 12v5c3 3 9 3 12 0v-5"/>
        </svg>
        <span class="lms-btn-text">LMS</span>
      `;
      headerRight.insertBefore(btn, headerRight.firstChild);
    }

    // 2. LMS Screen inside #main-content
    const main = document.getElementById("main-content");
    if (main && !document.getElementById("lms-screen")) {
      const screen = document.createElement("div");
      screen.id = "lms-screen";
      screen.className = "hidden";
      screen.innerHTML = _buildLMSScreenHTML();
      main.appendChild(screen);
    }

    // 3. Toast
    if (!document.getElementById("lms-save-toast")) {
      const toast = document.createElement("div");
      toast.id = "lms-save-toast";
      toast.className = "lms-save-toast";
      document.body.appendChild(toast);
    }
  }

  function _buildLMSScreenHTML() {
    return `
      <!-- Header -->
      <div class="lms-page-header">
        <div class="lms-page-header-left">
          <div class="lms-page-title">
            <span class="lms-icon">📊</span>
            Learning Management System
          </div>
          <div class="lms-page-subtitle">
            System Design &amp; AWS Architect Roadmap · 1 topic/day · 6:30–8:00 AM
          </div>
        </div>
        <div class="lms-header-actions">
          <button class="lms-reset-btn" id="lms-reset-btn" title="Reset all progress">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.95"/>
            </svg>
            Reset
          </button>
          <button class="lms-back-btn" id="lms-back-btn">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            Back to Learning
          </button>
        </div>
      </div>

      <!-- Start Date Config -->
      <div class="lms-config-bar">
        <label for="lms-start-date">📅 Study Start Date:</label>
        <input type="date" id="lms-start-date" />
        <span class="lms-config-info" id="lms-config-info"></span>
      </div>

      <!-- Dashboard Cards -->
      <div class="lms-dashboard-grid" id="lms-dashboard-grid"></div>

      <!-- Streaks -->
      <div class="lms-streak-row">
        <div class="lms-streak-card">
          <div class="lms-streak-icon">🔥</div>
          <div class="lms-streak-info">
            <div class="lms-streak-value" id="lms-streak-val">0</div>
            <div class="lms-streak-label">Current Streak (days)</div>
          </div>
        </div>
        <div class="lms-streak-card">
          <div class="lms-streak-icon">🏆</div>
          <div class="lms-streak-info">
            <div class="lms-streak-value" id="lms-best-streak-val">0</div>
            <div class="lms-streak-label">Best Streak (days)</div>
          </div>
        </div>
        <div class="lms-streak-card">
          <div class="lms-streak-icon">⏰</div>
          <div class="lms-streak-info">
            <div class="lms-streak-value">1.5 hrs</div>
            <div class="lms-streak-label">Daily Study Time</div>
          </div>
        </div>
        <div class="lms-streak-card">
          <div class="lms-streak-icon">📅</div>
          <div class="lms-streak-info">
            <div class="lms-streak-value">6:30 AM</div>
            <div class="lms-streak-label">Study Schedule</div>
          </div>
        </div>
      </div>

      <!-- Overall Progress -->
      <div class="lms-progress-section">
        <div class="lms-progress-header">
          <div class="lms-progress-title">Overall Roadmap Progress</div>
          <div class="lms-progress-pct" id="lms-main-pct">0%</div>
        </div>
        <div class="lms-progress-track">
          <div class="lms-progress-fill" id="lms-main-fill" style="width:0%"></div>
        </div>
        <div class="lms-progress-sub" id="lms-progress-sub"></div>
        <div class="lms-subject-bars" id="lms-subject-bars"></div>
      </div>

      <!-- Study Heatmap -->
      <div class="lms-heatmap-section">
        <div class="lms-section-title">📅 Study Heatmap — Last 16 Weeks</div>
        <div class="lms-heatmap-scroll">
          <div class="lms-heatmap-body">
            <div class="lms-heatmap-months" id="lms-heatmap-months"></div>
            <div style="display:flex;gap:3px;" id="lms-heatmap-weeks"></div>
          </div>
        </div>
        <div class="lms-heatmap-legend">
          <span>Less</span>
          <div class="lms-heatmap-legend-cell" style="background:var(--bg-elevated);border:1px solid var(--border)"></div>
          <div class="lms-heatmap-legend-cell" data-count="1"></div>
          <span>More</span>
          &nbsp;·&nbsp;
          <div class="lms-heatmap-legend-cell" style="background:transparent;border:1px dashed var(--border-muted)"></div>
          <span>Future / out of range</span>
        </div>
      </div>

      <!-- Daily Planner -->
      <div class="lms-planner-section">
        <div class="lms-section-title">📋 Daily Study Planner</div>
        <div class="lms-planner-toolbar">
          <div class="lms-filter-group">
            <label for="lms-filter-status">Filter:</label>
            <select class="lms-select-sm" id="lms-filter-status">
              <option value="all">All Days</option>
              <option value="not-started">Not Started</option>
              <option value="learning">Learning</option>
              <option value="completed">Completed</option>
            </select>
          </div>
          <button class="lms-jump-today-btn" id="lms-jump-today">⬇ Jump to Today</button>
        </div>
        <div class="lms-table-wrap">
          <table class="lms-planner-table">
            <thead>
              <tr>
                <th>Day / Date</th>
                <th>🌅 Topic<br><small style="font-weight:400;letter-spacing:0;text-transform:none;color:var(--text-muted)">6:30–8:00 AM</small></th>
                <th>Progress</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody id="lms-planner-tbody"></tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ── Attach Events ────────────────────────────────────────────
  function _attachEvents() {
    document.addEventListener("click", (e) => {
      // LMS nav button
      if (e.target.closest("#lms-nav-btn")) {
        showLMS();
        return;
      }
      // Back button
      if (e.target.closest("#lms-back-btn")) {
        hideLMS();
        return;
      }
      // Jump to today
      if (e.target.closest("#lms-jump-today")) {
        const tr = document.querySelector("#lms-planner-tbody .row-today");
        if (tr) tr.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      // Reset button
      if (e.target.closest("#lms-reset-btn")) {
        if (confirm("Reset ALL progress? This cannot be undone.")) {
          state.plans = [];
          _ensurePlanRows();
          saveState();
          renderDashboard();
          renderHeatmap();
          renderPlanner();
        }
      }
    });

    // Start date change
    document.addEventListener("change", (e) => {
      if (e.target.id === "lms-start-date") {
        state.startDate = e.target.value;
        saveState();
        _syncStartDate();
        renderDashboard();
        renderHeatmap();
        renderPlanner();
      }
      if (e.target.id === "lms-filter-status") {
        renderPlanner(e.target.value);
      }
    });

    // Auto-save when the tab is hidden or the page is unloaded
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) _silentSave();
    });
    window.addEventListener("beforeunload", _silentSave);
  }

  // ── Public ───────────────────────────────────────────────────
  return { init, showLMS, hideLMS };
})();

// Auto-init when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => LMS.init());
} else {
  LMS.init();
}
