/**
 * system-design.js — System Design Lab + Analytics
 * Preloaded problems, add/edit/delete, localStorage persistence
 */

// ── System Design Lab ────────────────────────────────────────
const SystemDesign = (() => {
  const STORAGE_KEY = "sd_lab_v1";

  const PRELOADED = [
    {
      id: "sd-1",
      problem: "Design a URL Shortener",
      concepts: "Hashing, NoSQL, Load Balancer, CDN, Caching (Redis)",
      difficulty: "medium",
      date: "2026-03-04",
      confidence: 60,
      notes: "Focus on collision handling and analytics tracking.",
    },
    {
      id: "sd-2",
      problem: "Design WhatsApp / Chat System",
      concepts: "WebSockets, Message Queue, Pub/Sub, Fanout, E2E Encryption",
      difficulty: "hard",
      date: "",
      confidence: 0,
      notes: "",
    },
    {
      id: "sd-3",
      problem: "Design Netflix / Video Streaming",
      concepts: "CDN, Adaptive Bitrate, S3, ElasticSearch, Microservices",
      difficulty: "hard",
      date: "",
      confidence: 0,
      notes: "",
    },
    {
      id: "sd-4",
      problem: "Design Uber / Ride Sharing",
      concepts: "Geospatial Index, WebSockets, Surge Pricing, Matching Engine",
      difficulty: "hard",
      date: "",
      confidence: 0,
      notes: "",
    },
    {
      id: "sd-5",
      problem: "Design Twitter / X Feed",
      concepts: "Fanout on Write vs Read, Timeline, Caching, Sharding",
      difficulty: "hard",
      date: "",
      confidence: 0,
      notes: "",
    },
    {
      id: "sd-6",
      problem: "Design a Rate Limiter",
      concepts: "Token Bucket, Sliding Window, Redis, API Gateway",
      difficulty: "medium",
      date: "",
      confidence: 0,
      notes: "",
    },
    {
      id: "sd-7",
      problem: "Design Amazon S3 / File Storage",
      concepts: "Chunking, Replication, Consistent Hashing, Object Storage",
      difficulty: "hard",
      date: "",
      confidence: 0,
      notes: "",
    },
    {
      id: "sd-8",
      problem: "Design a Distributed Cache (Redis)",
      concepts: "LRU Eviction, TTL, Cluster Mode, Cache Aside, Write-Through",
      difficulty: "medium",
      date: "",
      confidence: 0,
      notes: "",
    },
    {
      id: "sd-9",
      problem: "Design a Notification System",
      concepts: "Push/Pull, Message Queue, SNS, SQS, Throttling, Retry",
      difficulty: "medium",
      date: "",
      confidence: 0,
      notes: "",
    },
    {
      id: "sd-10",
      problem: "Design Google Docs (Collaborative Editing)",
      concepts: "OT / CRDT, WebSockets, Conflict Resolution, Versioning",
      difficulty: "hard",
      date: "",
      confidence: 0,
      notes: "",
    },
  ];

  let entries = [];
  let editingId = null;

  // ── Storage ─────────────────────────────────────────────────
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        entries = JSON.parse(raw);
        return;
      }
    } catch (_) {}
    entries = PRELOADED.map((e) => ({ ...e }));
    save();
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  }

  function _uid() {
    return (
      "sd-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    );
  }

  // ── Render ───────────────────────────────────────────────────
  function render() {
    if (!entries.length) load();

    const container = document.getElementById("sd-content");
    if (!container) return;

    const practiced = entries.filter((e) => e.date).length;
    const avgConf = entries.length
      ? Math.round(
          entries.reduce((s, e) => s + (e.confidence || 0), 0) / entries.length,
        )
      : 0;

    container.innerHTML = `
      <div class="sd-stats-bar">
        <div class="sd-stat-pill">
          <span class="sd-stat-val">${entries.length}</span>
          <span class="sd-stat-lbl">Total Problems</span>
        </div>
        <div class="sd-stat-pill">
          <span class="sd-stat-val">${practiced}</span>
          <span class="sd-stat-lbl">Practiced</span>
        </div>
        <div class="sd-stat-pill">
          <span class="sd-stat-val">${entries.length - practiced}</span>
          <span class="sd-stat-lbl">To Practice</span>
        </div>
        <div class="sd-stat-pill">
          <span class="sd-stat-val">${avgConf}%</span>
          <span class="sd-stat-lbl">Avg Confidence</span>
        </div>
      </div>
      <div class="sd-cards" id="sd-cards"></div>
    `;

    const grid = document.getElementById("sd-cards");
    if (!entries.length) {
      grid.innerHTML = `<div class="sd-empty"><div class="sd-empty-icon">🏗️</div><div class="sd-empty-title">No problems yet</div><div class="sd-empty-sub">Click "Add Problem" to get started.</div></div>`;
      return;
    }

    entries.forEach((e) => {
      const conf = e.confidence || 0;
      const dateStr = e.date
        ? new Date(e.date + "T00:00:00").toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : "Not practiced";
      const card = document.createElement("div");
      card.className = "sd-card";
      card.innerHTML = `
        <div class="sd-card-toprow">
          <div class="sd-card-title">${_esc(e.problem)}</div>
          <div class="sd-card-actions">
            <button class="sd-card-btn edit" data-id="${e.id}" title="Edit">✏️</button>
            <button class="sd-card-btn delete" data-id="${e.id}" title="Delete">🗑️</button>
          </div>
        </div>
        <div class="sd-card-meta">
          <span class="sd-badge ${e.difficulty}">${e.difficulty}</span>
          <span style="font-size:0.69rem;color:var(--text-muted)">${dateStr}</span>
        </div>
        <div class="sd-confidence-bar" title="Confidence: ${conf}%">
          <div class="sd-confidence-fill" style="width:${conf}%"></div>
        </div>
        <div class="sd-card-concepts"><strong style="color:var(--text-secondary);font-size:0.7rem;text-transform:uppercase;letter-spacing:.06em">Concepts:</strong> ${_esc(e.concepts)}</div>
        ${e.notes ? `<div class="sd-card-notes">"${_esc(e.notes)}"</div>` : ""}
        <div class="sd-card-date">Confidence: ${conf}%</div>
      `;
      grid.appendChild(card);
    });

    // Wire edit/delete
    grid.querySelectorAll(".sd-card-btn.edit").forEach((btn) => {
      btn.addEventListener("click", () => _openForm(btn.dataset.id));
    });
    grid.querySelectorAll(".sd-card-btn.delete").forEach((btn) => {
      btn.addEventListener("click", () => _deleteEntry(btn.dataset.id));
    });
  }

  function _esc(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ── Form ─────────────────────────────────────────────────────
  function _openForm(editId) {
    editingId = editId || null;
    const entry = editId ? entries.find((e) => e.id === editId) : null;
    const formEl = document.getElementById("sd-add-form");
    if (!formEl) return;

    formEl.classList.remove("hidden");
    formEl.innerHTML = `
      <div class="sd-form-title">${editId ? "Edit Problem" : "Add New Problem"}</div>
      <div class="sd-form-grid">
        <div class="sd-form-group" style="grid-column:1/-1">
          <label>Problem Name *</label>
          <input id="sd-f-problem" type="text" placeholder="e.g. Design a URL Shortener" value="${_esc(entry?.problem || "")}" />
        </div>
        <div class="sd-form-group" style="grid-column:1/-1">
          <label>Concepts Used</label>
          <input id="sd-f-concepts" type="text" placeholder="e.g. Hashing, CDN, Redis" value="${_esc(entry?.concepts || "")}" />
        </div>
        <div class="sd-form-group">
          <label>Difficulty</label>
          <select id="sd-f-difficulty">
            <option value="easy" ${entry?.difficulty === "easy" ? "selected" : ""}>Easy</option>
            <option value="medium" ${!entry || entry.difficulty === "medium" ? "selected" : ""}>Medium</option>
            <option value="hard" ${entry?.difficulty === "hard" ? "selected" : ""}>Hard</option>
          </select>
        </div>
        <div class="sd-form-group">
          <label>Date Practiced</label>
          <input id="sd-f-date" type="date" value="${entry?.date || ""}" />
        </div>
        <div class="sd-form-group">
          <label>Confidence Level (0–100)</label>
          <input id="sd-f-confidence" type="number" min="0" max="100" value="${entry?.confidence ?? 0}" />
        </div>
        <div class="sd-form-group">
          <label>Notes</label>
          <textarea id="sd-f-notes" placeholder="Key insights, weak areas...">${_esc(entry?.notes || "")}</textarea>
        </div>
      </div>
      <div class="sd-form-actions">
        <button class="sd-save-btn" id="sd-form-save">${editId ? "Save Changes" : "Add Problem"}</button>
        <button class="sd-cancel-btn" id="sd-form-cancel">Cancel</button>
      </div>
    `;

    formEl.scrollIntoView({ behavior: "smooth", block: "nearest" });

    document
      .getElementById("sd-form-save")
      ?.addEventListener("click", _saveForm);
    document
      .getElementById("sd-form-cancel")
      ?.addEventListener("click", _closeForm);
  }

  function _closeForm() {
    const formEl = document.getElementById("sd-add-form");
    if (formEl) formEl.classList.add("hidden");
    editingId = null;
  }

  function _saveForm() {
    const problem = document.getElementById("sd-f-problem")?.value.trim();
    if (!problem) {
      alert("Problem name is required.");
      return;
    }
    const newEntry = {
      id: editingId || _uid(),
      problem,
      concepts: document.getElementById("sd-f-concepts")?.value.trim() || "",
      difficulty: document.getElementById("sd-f-difficulty")?.value || "medium",
      date: document.getElementById("sd-f-date")?.value || "",
      confidence: Math.min(
        100,
        Math.max(
          0,
          parseInt(
            document.getElementById("sd-f-confidence")?.value || "0",
            10,
          ),
        ),
      ),
      notes: document.getElementById("sd-f-notes")?.value.trim() || "",
    };

    if (editingId) {
      const idx = entries.findIndex((e) => e.id === editingId);
      if (idx !== -1) entries[idx] = newEntry;
    } else {
      entries.unshift(newEntry);
    }

    save();
    _closeForm();
    render();
  }

  function _deleteEntry(id) {
    if (!confirm("Delete this problem entry?")) return;
    entries = entries.filter((e) => e.id !== id);
    save();
    render();
  }

  // ── Public Init ──────────────────────────────────────────────
  function init() {
    load();
    document
      .getElementById("sd-add-btn")
      ?.addEventListener("click", () => _openForm(null));
  }

  return { init, render };
})();

// ── Analytics Module ─────────────────────────────────────────
const Analytics = (() => {
  let _weeklyChart = null;
  let _subjectChart = null;

  function render() {
    const container = document.getElementById("analytics-content");
    if (!container) return;

    // Require LMS state to be ready
    const stats = typeof LMS !== "undefined" ? LMS.getStats() : null;
    if (!stats) {
      container.innerHTML = `<p style="color:var(--text-muted);padding:40px 0;text-align:center">Loading analytics...</p>`;
      return;
    }

    container.innerHTML = `
      <!-- Summary stats -->
      <div class="analytics-stats-row">
        <div class="analytics-stat-card">
          <div class="analytics-stat-val">${stats.completedTopics}</div>
          <div class="analytics-stat-lbl">Completed</div>
        </div>
        <div class="analytics-stat-card">
          <div class="analytics-stat-val">${stats.pct}%</div>
          <div class="analytics-stat-lbl">Progress</div>
        </div>
        <div class="analytics-stat-card">
          <div class="analytics-stat-val">${stats.streak}</div>
          <div class="analytics-stat-lbl">Streak</div>
        </div>
        <div class="analytics-stat-card">
          <div class="analytics-stat-val">${stats.daysLeft}</div>
          <div class="analytics-stat-lbl">Days Left</div>
        </div>
      </div>

      <!-- Charts -->
      <div class="analytics-grid">
        <div class="analytics-card">
          <div class="analytics-card-title">Weekly Topics Completed (Last 8 Weeks)</div>
          <div class="analytics-chart-wrap"><canvas id="chart-weekly"></canvas></div>
        </div>
        <div class="analytics-card">
          <div class="analytics-card-title">Progress by Subject</div>
          <div class="analytics-chart-wrap"><canvas id="chart-subjects"></canvas></div>
        </div>
      </div>
    `;

    _drawWeekly(stats);
    _drawSubjects(stats);
  }

  function _drawWeekly(stats) {
    const canvas = document.getElementById("chart-weekly");
    if (!canvas || !window.Chart) return;

    // Destroy previous instance
    if (_weeklyChart) {
      _weeklyChart.destroy();
      _weeklyChart = null;
    }

    const today = new Date();
    const labels = [];
    const data = [];

    for (let w = 7; w >= 0; w--) {
      const weekStart = new Date(today);
      weekStart.setDate(today.getDate() - w * 7 - today.getDay());
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);

      const label = weekStart.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      labels.push(label);

      // Count completions in this week
      let count = 0;
      const startStr =
        typeof LMS !== "undefined" ? LMS.getStartDate() : "2026-03-04";
      const plans = typeof LMS !== "undefined" ? LMS.getPlans() : [];
      plans.forEach((p, i) => {
        if (!p || p.morningStatus !== "completed") return;
        const d = new Date(startStr + "T00:00:00");
        d.setDate(d.getDate() + i);
        if (d >= weekStart && d <= weekEnd) count++;
      });
      data.push(count);
    }

    const isDark = document.documentElement.dataset.theme !== "light";
    const textColor = isDark ? "#94a3b8" : "#64748b";
    const gridColor = isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.07)";

    _weeklyChart = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Topics",
            data,
            backgroundColor: "rgba(59,130,246,0.5)",
            borderColor: "rgba(59,130,246,0.85)",
            borderWidth: 1.5,
            borderRadius: 6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { color: textColor, stepSize: 1 },
            grid: { color: gridColor },
          },
          x: {
            ticks: { color: textColor, maxRotation: 45 },
            grid: { display: false },
          },
        },
      },
    });
  }

  function _drawSubjects(stats) {
    const canvas = document.getElementById("chart-subjects");
    if (!canvas || !window.Chart) return;

    if (_subjectChart) {
      _subjectChart.destroy();
      _subjectChart = null;
    }

    const entries = Object.entries(stats.subjects);
    const labels = entries.map(([name]) => name.replace(/^\d+ · /, ""));
    const done = entries.map(([, d]) => d.done);
    const remaining = entries.map(([, d]) => d.total - d.done);

    const isDark = document.documentElement.dataset.theme !== "light";
    const textColor = isDark ? "#94a3b8" : "#64748b";

    _subjectChart = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Completed",
            data: done,
            backgroundColor: "rgba(34,197,94,0.55)",
            borderColor: "rgba(34,197,94,0.85)",
            borderWidth: 1.5,
            borderRadius: 4,
          },
          {
            label: "Remaining",
            data: remaining,
            backgroundColor: "rgba(255,255,255,0.06)",
            borderColor: "rgba(255,255,255,0.12)",
            borderWidth: 1,
            borderRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: "y",
        plugins: {
          legend: {
            labels: { color: textColor, boxWidth: 12, padding: 12 },
          },
        },
        scales: {
          x: {
            stacked: true,
            ticks: { color: textColor },
            grid: {
              color: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
            },
          },
          y: {
            stacked: true,
            ticks: { color: textColor, font: { size: 10 } },
            grid: { display: false },
          },
        },
      },
    });
  }

  return { render };
})();
