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
    _attachEvents();
    // Ensure toast container exists
    if (!document.getElementById("lms-save-toast")) {
      const toast = document.createElement("div");
      toast.id = "lms-save-toast";
      toast.className = "lms-save-toast";
      document.body.appendChild(toast);
    }
  }

  // ── Attach Events ────────────────────────────────────────────
  function _attachEvents() {
    document.addEventListener("click", (e) => {
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

  // ── Public API ───────────────────────────────────────────────
  function getTodayTopic() {
    const today = todayStr();
    const start = state.startDate;
    const msPerDay = 86400000;
    const dayOffset = Math.floor(
      (new Date(today + "T00:00:00") - new Date(start + "T00:00:00")) /
        msPerDay,
    );
    if (dayOffset < 0 || dayOffset >= TOTAL_DAYS) return null;
    const p = state.plans[dayOffset];
    if (!p) return null;
    const topic = LMS_TOPICS[p.morningTopicId];
    return topic
      ? { ...topic, status: p.morningStatus, day: dayOffset + 1, date: today }
      : null;
  }

  function getStartDate() {
    return state ? state.startDate : "2026-03-04";
  }
  function getPlans() {
    return state ? state.plans : [];
  }

  return {
    init,
    renderDashboard,
    renderPlanner,
    renderHeatmap,
    getStats,
    getTodayTopic,
    getStartDate,
    getPlans,
    _syncStartDate,
  };
})();

// Auto-init when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => LMS.init());
} else {
  LMS.init();
}
