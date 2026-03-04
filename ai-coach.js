/* ============================================================
   ai-coach.js — Personal AI Learning Coach for Engineers
   Vanilla JS IIFE module — no external APIs, fully local
   ============================================================ */

const AICoach = (() => {
  "use strict";

  // ── Storage ──────────────────────────────────────────────────
  const STORE_KEY = "ai_coach_v1";

  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch {
      return {};
    }
  }

  function saveState(patch) {
    const cur = loadState();
    const next = Object.assign({}, cur, patch);
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
    return next;
  }

  // ── Knowledge Base ───────────────────────────────────────────
  const KB = {
    // intent → keywords[]
    intents: {
      greeting: [
        "hello",
        "hi",
        "hey",
        "morning",
        "evening",
        "what's up",
        "howdy",
      ],
      help: ["help", "what can you", "what do you", "commands", "features"],
      todayPlan: [
        "today",
        "plan",
        "schedule",
        "what should",
        "what to study",
        "daily",
      ],
      weakAreas: [
        "weak",
        "struggle",
        "confusion",
        "difficult",
        "hard topic",
        "need review",
      ],
      revision: [
        "revise",
        "revision",
        "review",
        "revisit",
        "spaced repetition",
        "forget",
      ],
      interviewPrep: [
        "interview",
        "system design interview",
        "how would you design",
        "design a",
      ],
      diagram: [
        "diagram",
        "architecture",
        "draw",
        "visualize",
        "show me",
        "ascii",
      ],
      progress: [
        "progress",
        "streak",
        "how many",
        "stats",
        "how far",
        "completed",
      ],
      motivation: [
        "motivate",
        "tired",
        "feel like",
        "give up",
        "stuck",
        "lazy",
        "boring",
      ],
      explain: [
        "explain",
        "what is",
        "define",
        "tell me about",
        "describe",
        "how does",
      ],
    },

    // quick explanations per topic keyword
    explanations: {
      dns: "DNS (Domain Name System) translates human-readable domain names (e.g. google.com) into IP addresses. Flows: Browser → OS cache → Resolver → Root → TLD → Authoritative NS → IP returned.",
      tcp: "TCP (Transmission Control Protocol) is connection-oriented, reliable, ordered delivery. Uses 3-way handshake (SYN→SYN-ACK→ACK). Retransmits lost packets via ACK+timeout.",
      udp: "UDP is connectionless, faster, no delivery guarantee. Used for DNS, video streaming, gaming. Lower overhead than TCP.",
      http: "HTTP is an application-layer protocol for transferring hypertext. Request/Response model. Methods: GET, POST, PUT, DELETE, PATCH. Status codes: 2xx success, 3xx redirect, 4xx client error, 5xx server error.",
      https:
        "HTTPS = HTTP over TLS/SSL. Encrypts data in transit. Certificate Authority validates server identity. Browser shows padlock.",
      jwt: "JWT (JSON Web Token) = Header.Payload.Signature (base64). Stateless auth — server doesn't store sessions. Refresh tokens renew access tokens. Never store sensitive data in payload.",
      cors: "CORS (Cross-Origin Resource Sharing) is a browser security mechanism. Server sets Access-Control-Allow-Origin headers to permit cross-origin requests. Preflight OPTIONS request for non-simple requests.",
      rest: "REST (Representational State Transfer) is a stateless, client-server architectural style. Resources identified by URIs. Uses HTTP methods. Uniform interface. Cacheable.",
      sql: "SQL: SELECT cols FROM table WHERE cond GROUP BY col HAVING cond ORDER BY col LIMIT n. JOINs link tables via foreign keys. ACID = Atomicity, Consistency, Isolation, Durability.",
      redis:
        "Redis is an in-memory key-value store. Used for caching, sessions, pub/sub, rate limiting. Supports strings, lists, sets, hashes, sorted sets. Ultra-fast (<1ms latency).",
      cdn: "CDN (Content Delivery Network) caches static assets at edge servers globally. Reduces latency by serving from nearest PoP. Examples: CloudFront, Cloudflare, Akamai.",
      "load balancer":
        "Load Balancer distributes traffic across multiple servers. Algorithms: Round Robin, Least Connections, IP Hash. Types: L4 (TCP) vs L7 (HTTP). AWS ALB is L7.",
      cache:
        "Caching stores frequently accessed data in fast storage. Cache-Aside (lazy): app checks cache first. Write-Through: writes to cache + DB. TTL controls expiry. Hit ratio = hits/(hits+misses).",
      microservices:
        "Microservices = independently deployable services with single responsibility. Communicate via REST/gRPC/events. Benefits: independent scaling, tech diversity. Challenges: network latency, distributed transactions.",
      docker:
        "Docker packages apps into containers (image = code + runtime + deps). Dockerfile defines build steps. docker-compose for multi-container apps. Layer caching speeds builds.",
      kubernetes:
        "K8s orchestrates containers. Pod = smallest unit (1+ containers). Service = stable network endpoint. Deployment = desired state. HPA autoscales pods. Ingress handles external traffic.",
      aws: "AWS key services: EC2 (VMs), S3 (object storage), RDS (managed DB), Lambda (serverless), ECS/EKS (containers), CloudFront (CDN), Route53 (DNS), IAM (access control), VPC (networking).",
      lambda:
        "AWS Lambda runs code without managing servers. Event-driven (API GW, S3, SQS triggers). Pay per invocation + duration. Cold start latency. Max 15 min timeout. Use for bursty, short-lived tasks.",
      "api gateway":
        "AWS API Gateway = managed API front door. Features: auth (JWT/Cognito), throttling, caching, WebSocket, Lambda proxy. Regional or edge-optimized deployment.",
      rds: "AWS RDS = managed relational DB. Supports MySQL, PostgreSQL, Aurora, SQL Server. Multi-AZ for HA. Read replicas for read scaling. Automated backups and patching.",
      s3: "S3 = object storage with 11 9s durability. Buckets contain objects. Storage classes: Standard, IA, Glacier. Features: versioning, lifecycle policies, event notifications, presigned URLs.",
      autoscaling:
        "AWS Auto Scaling adjusts EC2 capacity based on rules. Target tracking policy, step scaling policy. Cooldown period prevents thrashing. Works with ALB for traffic distribution.",
      "cap theorem":
        "CAP Theorem: In a distributed system, you can only guarantee 2 of 3 — Consistency, Availability, Partition Tolerance. Real systems choose CP (MongoDB) or AP (Cassandra).",
      sharding:
        "Database sharding horizontally splits data across multiple DB instances. Shard key determines data placement. Benefits: write scaling. Challenges: cross-shard queries, rebalancing.",
      "message queue":
        "Message queues (SQS, RabbitMQ, Kafka) decouple producers from consumers. SQS: simple queuing. Kafka: high-throughput event streaming with log retention and replay.",
      hashing:
        "Bcrypt is slow by design (work factor) — makes brute force computationally expensive. Never store plaintext passwords. Use crypto library's compare() to prevent timing attacks.",
      "rate limiting":
        "Rate limiting protects APIs from abuse. Algorithms: Token Bucket, Sliding Window. Store counts in Redis. Return 429 Too Many Requests. Include Retry-After header.",
      pagination:
        "Offset pagination: LIMIT/OFFSET — simple but slow on large tables. Cursor pagination: keyset (WHERE id > last_seen_id) — O(1) unlike offset scans. Use cursor for large datasets.",
      websocket:
        "WebSockets = persistent bidirectional TCP connection. Upgrade from HTTP handshake. Used for real-time features (chat, notifications, live data). vs SSE (server-only push).",
      indexing:
        "DB indexes speed up queries (B-Tree, Hash). Composite index: column order matters. Too many indexes slow down writes. EXPLAIN ANALYZE shows query plan and index usage.",
    },

    // random motivational quotes
    motivation: [
      "Every expert was once a beginner. Your 14 years got you here — this next chapter is just another layer on top.",
      "System Design is a skill, not a talent. The more patterns you see, the faster you'll recognise them at the board.",
      "Consistency > intensity. One topic per day compounds into mastery in 12 months.",
      "You don't need to know everything. You need to know how to think through anything.",
      "AWS Solutions Architect is 80% fundamentals. You're building those fundamentals right now.",
      "The engineers who shine in interviews are the ones who've thought about trade-offs, not just memorised solutions.",
      "Progress is rarely linear. A slow day today is still a day ahead of where you were yesterday.",
    ],
  };

  // ── Chat Engine ──────────────────────────────────────────────
  const Chat = (() => {
    let _open = false;
    const _history = []; // {role, text, time}

    function detectIntent(msg) {
      const lower = msg.toLowerCase();
      for (const [intent, kws] of Object.entries(KB.intents)) {
        if (kws.some((k) => lower.includes(k))) return intent;
      }
      // topic lookup in explanations
      for (const topic of Object.keys(KB.explanations)) {
        if (lower.includes(topic)) return "explain_topic_" + topic;
      }
      return "unknown";
    }

    function buildResponse(msg) {
      const intent = detectIntent(msg);
      const lower = msg.toLowerCase();

      if (intent === "greeting") {
        const hour = new Date().getHours();
        const timeOfDay =
          hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
        const topic =
          typeof LMS !== "undefined" && LMS.getTodayTopic
            ? LMS.getTodayTopic()
            : null;
        let resp = `Good ${timeOfDay}! I'm your AI Learning Coach. `;
        if (topic) {
          resp += `Today's topic is <strong>${topic.title}</strong>. Ready to dive in?`;
        } else {
          resp += `How can I help you today?`;
        }
        return resp;
      }

      if (intent === "help") {
        return `I can help you with:<ul>
          <li>📅 <strong>Daily Plan</strong> — ask "what should I study today?"</li>
          <li>🔍 <strong>Topic Explanations</strong> — ask "explain JWT" or "what is Redis?"</li>
          <li>💪 <strong>Weak Areas</strong> — ask "show my weak areas"</li>
          <li>📝 <strong>Revision</strong> — ask "what should I revise?"</li>
          <li>🎯 <strong>Interview Prep</strong> — ask "system design interview tips"</li>
          <li>🏗️ <strong>Architecture</strong> — ask "show diagram for URL shortener"</li>
          <li>📊 <strong>Progress</strong> — ask "how is my progress?"</li>
        </ul>`;
      }

      if (intent === "todayPlan") {
        if (typeof LMS !== "undefined" && LMS.getTodayTopic) {
          const topic = LMS.getTodayTopic();
          if (topic) {
            return `📅 <strong>Today: Day ${topic.day} — ${topic.title}</strong><br><br>
              <strong>🌅 Morning session (6:30–8:00 AM):</strong> Study the concept. Focus on: What is it? Why does it exist? How does it work?<br><br>
              <strong>🌙 Evening session (9:30–10:30 PM):</strong> Practice. Try to explain it from scratch, draw a diagram, and write one example.<br><br>
              💡 Tip: If you know the <em>why</em> behind ${topic.title}, you'll ace any interview question on it.`;
          }
        }
        return `I couldn't find today's topic in your plan. Open the <strong>Planner</strong> panel to set up your study schedule.`;
      }

      if (intent === "weakAreas") {
        const weak = WeakAreaDetector.getWeakTopics();
        if (!weak.length)
          return `🎉 No obvious weak areas detected yet. Keep logging your topic confidence in the Planner!`;
        const list = weak
          .slice(0, 5)
          .map(
            (w) =>
              `<li><strong>${w.title}</strong> — ${w.confidence} confidence</li>`,
          )
          .join("");
        return `Your top focus areas:<ul>${list}</ul>Head to the <strong>AI Coach</strong> panel → Weak Areas tab for details.`;
      }

      if (intent === "revision") {
        const due = RevisionEngine.getDueTopics();
        if (!due.length)
          return `✅ Nothing urgent to revise today! You're up to date. Keep going.`;
        const list = due
          .slice(0, 5)
          .map((d) => `<li>${d.title} <em>(${d.reason})</em></li>`)
          .join("");
        return `Topics due for revision:<ul>${list}</ul>Open the <strong>AI Coach</strong> panel → Revision tab to review them.`;
      }

      if (intent === "interviewPrep") {
        return `🎯 <strong>System Design Interview Framework:</strong><br><br>
          1. <strong>Clarify Requirements</strong> — Ask about scale, features, constraints (2-3 min)<br>
          2. <strong>Estimate Scale</strong> — DAU, requests/sec, data size<br>
          3. <strong>High-Level Design</strong> — Client → LB → API → DB, Cache, CDN<br>
          4. <strong>Deep Dive</strong> — Pick 2–3 components interviewer asks about<br>
          5. <strong>Trade-offs</strong> — Consistency vs Availability, SQL vs NoSQL<br><br>
          Open the <strong>AI Coach</strong> panel → Interview Coach to practice with real problems!`;
      }

      if (intent === "diagram") {
        const topicMatch = Object.keys(DiagramSuggester.DIAGRAMS).find((t) =>
          lower.includes(t),
        );
        if (topicMatch) {
          const d = DiagramSuggester.DIAGRAMS[topicMatch];
          return `🏗️ <strong>${d.title}:</strong><br><pre style="font-family:monospace;font-size:0.75rem;line-height:1.8;background:var(--bg-elevated);padding:12px;border-radius:8px;overflow-x:auto;margin-top:8px;">${d.ascii}</pre>`;
        }
        return `I can draw diagrams for: ${Object.keys(DiagramSuggester.DIAGRAMS).join(", ")}. Try "show diagram for URL shortener".`;
      }

      if (intent === "progress") {
        if (typeof LMS !== "undefined" && LMS.getStats) {
          const s = LMS.getStats();
          return `📊 <strong>Your Progress:</strong><br><br>
            ✅ Completed: <strong>${s.completedTopics}</strong> topics<br>
            📚 Remaining: <strong>${s.remaining}</strong> topics<br>
            🎯 Overall: <strong>${s.pct}%</strong><br>
            🔥 Current Streak: <strong>${s.streak} days</strong><br>
            ⭐ Best Streak: <strong>${s.bestStreak} days</strong><br><br>
            ${s.pct >= 80 ? "You're in the home stretch! 🚀" : s.pct >= 50 ? "Halfway there — keep the momentum! 💪" : "Early stages — consistency is everything! 🌱"}`;
        }
        return `Open the Dashboard to see your full progress stats.`;
      }

      if (intent === "motivation") {
        const quote =
          KB.motivation[Math.floor(Math.random() * KB.motivation.length)];
        return `💬 <em>"${quote}"</em>`;
      }

      // Topic explanation
      if (intent.startsWith("explain_topic_")) {
        const topicKey = intent.replace("explain_topic_", "");
        return `📖 <strong>${topicKey.toUpperCase()}:</strong><br><br>${KB.explanations[topicKey]}`;
      }

      // General keyword fallback in explanations
      for (const [key, explanation] of Object.entries(KB.explanations)) {
        if (lower.includes(key)) {
          return `📖 <strong>${key.toUpperCase()}:</strong><br><br>${explanation}`;
        }
      }

      // Unknown
      const suggestions = [
        "explain JWT",
        "today's plan",
        "show my weak areas",
        "system design interview",
        "explain Redis",
      ];
      const rnd = suggestions[Math.floor(Math.random() * suggestions.length)];
      return `I'm not sure about that — I'm a local AI tuned for backend/cloud engineering topics. Try asking things like:<ul>
        <li>"${rnd}"</li>
        <li>"what should I study today?"</li>
        <li>"show diagram for URL shortener"</li>
        <li>"motivate me"</li>
      </ul>`;
    }

    function addMessage(role, text) {
      const time = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      _history.push({ role, text, time });
      const container = document.getElementById("aic-chat-messages");
      if (!container) return;

      const div = document.createElement("div");
      div.className = `aic-msg ${role}`;
      div.innerHTML = `
        <div class="aic-msg-avatar">${role === "assistant" ? "🤖" : "👤"}</div>
        <div>
          <div class="aic-msg-bubble">${text}</div>
          <div class="aic-msg-time">${time}</div>
        </div>`;
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
    }

    function showTyping() {
      const container = document.getElementById("aic-chat-messages");
      if (!container) return null;

      const div = document.createElement("div");
      div.className = "aic-typing";
      div.id = "aic-typing-indicator";
      div.innerHTML = `
        <div class="aic-msg-avatar">🤖</div>
        <div class="aic-typing-bubble">
          <span class="aic-typing-dot"></span>
          <span class="aic-typing-dot"></span>
          <span class="aic-typing-dot"></span>
        </div>`;
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
      return div;
    }

    function removeTyping() {
      document.getElementById("aic-typing-indicator")?.remove();
    }

    function sendMessage(msg) {
      if (!msg.trim()) return;
      addMessage("user", msg.trim());

      const input = document.getElementById("aic-chat-input");
      const sendBtn = document.getElementById("aic-chat-send");
      if (input) input.value = "";
      if (sendBtn) sendBtn.disabled = true;

      showTyping();
      const delay = 600 + Math.random() * 600;

      setTimeout(() => {
        removeTyping();
        const response = buildResponse(msg);
        addMessage("assistant", response);
        if (sendBtn) sendBtn.disabled = false;

        // Badge if closed
        if (!_open) {
          const badge = document.querySelector(
            "#aic-chat-trigger .aic-trigger-badge",
          );
          if (badge) badge.classList.add("show");
        }
      }, delay);
    }

    function open() {
      const panel = document.getElementById("aic-chat-panel");
      if (panel) panel.classList.remove("hidden");
      _open = true;
      const badge = document.querySelector(
        "#aic-chat-trigger .aic-trigger-badge",
      );
      if (badge) badge.classList.remove("show");
      setTimeout(() => {
        const input = document.getElementById("aic-chat-input");
        if (input) input.focus();
      }, 120);
    }

    function close() {
      const panel = document.getElementById("aic-chat-panel");
      if (panel) panel.classList.add("hidden");
      _open = false;
    }

    function toggle() {
      _open ? close() : open();
    }

    function isOpen() {
      return _open;
    }

    function init() {
      // Trigger button
      const trigger = document.getElementById("aic-chat-trigger");
      if (trigger) trigger.addEventListener("click", toggle);

      // Close button
      const closeBtn = document.getElementById("aic-chat-close");
      if (closeBtn) closeBtn.addEventListener("click", close);

      // Send button
      const sendBtn = document.getElementById("aic-chat-send");
      if (sendBtn)
        sendBtn.addEventListener("click", () => {
          const val = document.getElementById("aic-chat-input")?.value;
          if (val) sendMessage(val);
        });

      // Input keyboard
      const input = document.getElementById("aic-chat-input");
      if (input) {
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            const val = input.value;
            if (val) sendMessage(val);
          }
        });
      }

      // Suggestion chips
      document.querySelectorAll(".aic-suggestion").forEach((chip) => {
        chip.addEventListener("click", () => {
          const text = chip.dataset.msg || chip.textContent;
          sendMessage(text.trim());
          open();
        });
      });

      // Welcome message
      if (_history.length === 0) {
        addMessage(
          "assistant",
          `👋 Hello! I'm your <strong>AI Learning Coach</strong>. I'm here to help you with:<br>
          📅 Daily study plans &nbsp;|&nbsp; 📖 Topic explanations<br>
          🔍 Weak area detection &nbsp;|&nbsp; 🎯 Interview prep<br><br>
          What would you like to do today?`,
        );
      }
    }

    return { init, open, close, toggle, sendMessage, isOpen };
  })();

  // ── Weak Area Detector ───────────────────────────────────────
  const WeakAreaDetector = (() => {
    function getWeakTopics() {
      if (typeof LMS === "undefined" || !LMS.getPlans) return [];
      const plans = LMS.getPlans();
      if (!plans || !plans.length) return [];

      const weak = [];
      for (const plan of plans) {
        if (plan.status !== "done") continue;
        const notes = (plan.notes || "").toLowerCase();
        let confidence = "unknown";
        let confScore = 50;

        if (
          notes.includes("confidence:low") ||
          notes.includes("conf:low") ||
          notes.includes("low confidence")
        ) {
          confidence = "low";
          confScore = 20;
        } else if (
          notes.includes("confidence:medium") ||
          notes.includes("conf:medium") ||
          notes.includes("medium confidence")
        ) {
          confidence = "medium";
          confScore = 55;
        } else if (
          notes.includes("confidence:high") ||
          notes.includes("conf:high") ||
          notes.includes("high confidence")
        ) {
          confidence = "high";
          confScore = 90;
        }

        // Check stored coach data for confidence ratings
        const state = loadState();
        const stored = state.confidenceRatings || {};
        const key = `${plan.subject}_${plan.day}`;
        if (stored[key]) {
          const r = stored[key];
          if (r === "low") {
            confidence = "low";
            confScore = 20;
          }
          if (r === "medium") {
            confidence = "medium";
            confScore = 55;
          }
          if (r === "high") {
            confidence = "high";
            confScore = 90;
          }
        }

        if (confidence === "low" || confidence === "medium") {
          weak.push({
            title: plan.title || `${plan.subject} Day ${plan.day}`,
            subject: plan.subject,
            day: plan.day,
            confidence,
            confScore,
          });
        }
      }

      // Also flag skipped topics
      for (const plan of plans) {
        if (plan.status === "skipped") {
          weak.push({
            title: plan.title || `${plan.subject} Day ${plan.day}`,
            subject: plan.subject,
            day: plan.day,
            confidence: "skipped",
            confScore: 0,
          });
        }
      }

      return weak.sort((a, b) => a.confScore - b.confScore);
    }

    function saveConfidence(subject, day, rating) {
      const state = loadState();
      const ratings = state.confidenceRatings || {};
      ratings[`${subject}_${day}`] = rating;
      saveState({ confidenceRatings: ratings });
    }

    function renderWeakList(containerEl) {
      const weak = getWeakTopics();
      if (!weak.length) {
        containerEl.innerHTML = `<div class="aic-weak-empty">🎉 No weak areas detected yet.<br>
          Log your confidence when reviewing topics in the Planner.</div>`;
        return;
      }

      containerEl.innerHTML = weak
        .slice(0, 10)
        .map((w) => {
          const pct = w.confScore;
          const cls = pct < 40 ? "low" : pct < 70 ? "medium" : "high";
          const label =
            w.confidence === "skipped"
              ? "Skipped"
              : `${w.confidence} confidence`;
          return `<div class="aic-weak-item">
          <div class="aic-weak-bar-wrap">
            <div class="aic-weak-name">${escHtml(w.title)}</div>
            <div class="aic-weak-bar">
              <div class="aic-weak-bar-fill ${cls}" style="width:${pct}%"></div>
            </div>
          </div>
          <div class="aic-weak-conf" title="${label}">${pct}%</div>
        </div>`;
        })
        .join("");
    }

    return { getWeakTopics, saveConfidence, renderWeakList };
  })();

  // ── Revision Engine ──────────────────────────────────────────
  const RevisionEngine = (() => {
    // Spaced repetition intervals in days: 1, 3, 7, 14, 30
    const INTERVALS = [1, 3, 7, 14, 30];

    function getDueTopics() {
      if (typeof LMS === "undefined" || !LMS.getPlans) return [];
      const plans = LMS.getPlans();
      if (!plans) return [];

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const state = loadState();
      const reviewLog = state.reviewLog || {};

      const due = [];
      for (const plan of plans) {
        if (plan.status !== "done") continue;
        const completedDate = plan.completedDate
          ? new Date(plan.completedDate)
          : null;
        if (!completedDate) continue;

        completedDate.setHours(0, 0, 0, 0);
        const daysSinceComplete = Math.floor(
          (today - completedDate) / 86400000,
        );

        // Find next due interval
        const key = `${plan.subject}_${plan.day}`;
        const reviewCount = reviewLog[key] || 0;
        const nextInterval =
          INTERVALS[Math.min(reviewCount, INTERVALS.length - 1)];

        let reason = "";
        let urgency = "normal";

        if (daysSinceComplete >= nextInterval) {
          if (daysSinceComplete >= nextInterval * 2) {
            reason = `Overdue by ${daysSinceComplete - nextInterval} days`;
            urgency = "urgent";
          } else {
            reason = `Due today (${nextInterval}-day review)`;
            urgency = "due";
          }
          due.push({
            title: plan.title || `${plan.subject} Day ${plan.day}`,
            key,
            reason,
            urgency,
            daysSince: daysSinceComplete,
          });
        }
      }

      return due.sort((a, b) => {
        const order = { urgent: 0, due: 1, normal: 2 };
        return order[a.urgency] - order[b.urgency];
      });
    }

    function markReviewed(key) {
      const state = loadState();
      const log = state.reviewLog || {};
      log[key] = (log[key] || 0) + 1;
      saveState({ reviewLog: log });
    }

    function renderRevisionList(containerEl) {
      const due = getDueTopics();
      if (!due.length) {
        containerEl.innerHTML = `<div class="aic-revision-empty">✅ Nothing to revise right now. Keep completing topics!</div>`;
        return;
      }

      containerEl.innerHTML = due
        .slice(0, 8)
        .map(
          (d) => `
        <div class="aic-revision-item" data-key="${escHtml(d.key)}">
          <div class="aic-revision-dot ${d.urgency}"></div>
          <div class="aic-revision-text">
            <div class="aic-revision-name">${escHtml(d.title)}</div>
            <div class="aic-revision-meta">${escHtml(d.reason)}</div>
          </div>
          <button class="aic-action-btn" onclick="AICoach._markRevised('${escHtml(d.key)}', this)" style="flex-shrink:0;margin-top:0;font-size:0.68rem;padding:4px 9px;">
            ✓ Done
          </button>
        </div>`,
        )
        .join("");
    }

    return { getDueTopics, markReviewed, renderRevisionList };
  })();

  // ── Interview Coach ──────────────────────────────────────────
  const InterviewCoach = (() => {
    const PROBLEMS = [
      {
        id: "url-shortener",
        title: "Design a URL Shortener",
        difficulty: "medium",
        tags: ["Hashing", "NoSQL", "CDN"],
        steps: [
          {
            title: "Clarify Requirements",
            content: `<h4>Functional Requirements</h4>
              <ul>
                <li>Shorten a long URL → short URL (e.g. bit.ly/xyz123)</li>
                <li>Redirect short URL → original URL</li>
                <li>Optional: Custom alias, expiry, analytics</li>
              </ul>
              <h4>Non-Functional Requirements</h4>
              <ul>
                <li>High availability (99.99%)</li>
                <li>Low latency reads (&lt;10ms)</li>
                <li>100M URLs/day write, 10B reads/day</li>
              </ul>`,
          },
          {
            title: "Estimate Scale",
            content: `<h4>Back-of-envelope Calculations</h4>
              <ul>
                <li>Writes: 100M/day ≈ 1160 RPS</li>
                <li>Reads: 10B/day ≈ 115K RPS (read-heavy, 100:1 ratio)</li>
                <li>Storage: 100M × 500 bytes × 365 days = ~18TB/year</li>
                <li>Short URL: 7 chars from [a-z, A-Z, 0-9] = 62^7 ≈ 3.5 trillion combos</li>
              </ul>
              <p>Key insight: <span class="highlight">Read-heavy system → prioritise read path with cache</span></p>`,
          },
          {
            title: "High-Level Design",
            content: `<h4>System Architecture</h4>
              <div class="arch-diagram">Client → CDN → LB → API Service → Redis Cache
                                                               ↓
                                                          KV Store (DynamoDB)
                                                               ↓
                                                      Analytics (Kafka → ClickHouse)</div>
              <ul>
                <li><strong>KV Store</strong> (DynamoDB): short_code → {long_url, created_at, expiry}</li>
                <li><strong>Redis</strong>: Cache hot short codes (TTL 24h). Cache-aside pattern.</li>
                <li><strong>ID Generation</strong>: Snowflake ID or counter → Base62 encode → 7 chars</li>
              </ul>`,
          },
          {
            title: "Deep Dive",
            content: `<h4>Key Design Decisions</h4>
              <p><strong>ID Generation Options:</strong></p>
              <ul>
                <li>✅ Snowflake (64-bit) + Base62 — distributed, no collision</li>
                <li>⚠️ MD5 hash of URL — collision possible, need de-dup check</li>
                <li>⚠️ Counter + DB — single point of failure</li>
              </ul>
              <p><strong>Redirect Flow:</strong></p>
              <ul>
                <li>Hit Redis first. Cache miss → DynamoDB → update Redis</li>
                <li>Return HTTP 301 (permanent) vs 302 (temporary) — 302 bypasses browser cache</li>
              </ul>
              <p><strong>Custom Alias:</strong> Check uniqueness in DB. Reserve banned words list.</p>`,
          },
          {
            title: "Trade-offs",
            content: `<h4>Questions to Pre-empt</h4>
              <ul>
                <li><strong>SQL vs NoSQL?</strong> NoSQL (DynamoDB) — simple key lookups, massive scale, no JOINs needed</li>
                <li><strong>Cache invalidation?</strong> Set TTL on Redis. DELETE from cache on URL delete.</li>
                <li><strong>Analytics?</strong> Don't block redirect. Emit Kafka event asynchronously.</li>
                <li><strong>Security?</strong> Rate-limit URL creation per IP. Block malicious URLs via Safe Browsing API.</li>
                <li><strong>Hot URLs?</strong> Popular links cached at CDN edge for &lt;5ms redirects globally.</li>
              </ul>
              <p>🎯 <strong>Key trade-off:</strong> 301 = fewer server hits, 302 = better analytics accuracy.</p>`,
          },
        ],
      },
      {
        id: "instagram",
        title: "Design Instagram Feed",
        difficulty: "hard",
        tags: ["Fan-out", "CDN", "Cache"],
        steps: [
          {
            title: "Clarify Requirements",
            content: `<h4>Core Features</h4><ul>
              <li>Upload photos/videos</li>
              <li>Follow/Unfollow users</li>
              <li>View home feed (posts from followed users)</li>
              <li>Like, Comment</li>
            </ul>
            <h4>Scale</h4><ul>
              <li>1B DAU, 100M posts/day</li>
              <li>Average user follows 300 people</li>
              <li>Feed = last 20 posts from followed users</li>
            </ul>`,
          },
          {
            title: "Estimate Scale",
            content: `<h4>Numbers</h4><ul>
              <li>Uploads: 100M/day ≈ 1160/sec</li>
              <li>Feed reads: 1B users × 10 opens/day ≈ 115K/sec</li>
              <li>Photo storage: 100M × 100KB avg = 10TB/day</li>
              <li>Read:Write ratio ≈ 100:1</li>
            </ul>
            <p>Key: <span class="highlight">Write at scale → Fan-out strategy choice critical</span></p>`,
          },
          {
            title: "High-Level Design",
            content: `<div class="arch-diagram">Upload: Client → API → Media Service → S3 → CDN
                                            ↓
                                    Notification Queue (Kafka)
                                            ↓
                                     Feed Builder Workers

Read: Client → Feed Service → Feed Cache (Redis) → DB fallback</div>
            <ul>
              <li><strong>Object Storage</strong>: S3 for media, CloudFront CDN for delivery</li>
              <li><strong>Feed</strong>: Pre-computed and stored in Redis per user</li>
            </ul>`,
          },
          {
            title: "Deep Dive",
            content: `<h4>Fan-out Strategy</h4>
            <p><strong>Fan-out on Write (Push)</strong>: On post, push to all followers' feed caches.</p>
            <ul>
              <li>✅ Fast reads (feed already built)</li>
              <li>❌ Expensive for celebrities (100M+ followers)</li>
            </ul>
            <p><strong>Fan-out on Read (Pull)</strong>: Build feed fresh on request.</p>
            <ul><li>❌ Slow for users following many active accounts</li></ul>
            <p><strong>Hybrid (Instagram's approach)</strong>: Push for normal users, Pull for celebrities. Merge at read time.</p>`,
          },
          {
            title: "Trade-offs",
            content: `<h4>Key Decisions</h4><ul>
              <li><strong>Storage</strong>: Cassandra for feed (wide-row: user_id → [post_ids]). Fast range scans.</li>
              <li><strong>Cache</strong>: Redis stores pre-computed feed. Cache 20–50 posts. Evict LRU.</li>
              <li><strong>Ranking</strong>: Simple chronological first, add ML ranking layer later.</li>
              <li><strong>Pagination</strong>: Cursor-based (not offset). Pass last seen post_id.</li>
              <li><strong>Stories</strong>: Different model — TTL-based (24h), push to followers immediately.</li>
            </ul>`,
          },
        ],
      },
      {
        id: "chat-system",
        title: "Design a Chat System",
        difficulty: "hard",
        tags: ["WebSocket", "Message Queue", "NoSQL"],
        steps: [
          {
            title: "Clarify Requirements",
            content: `<h4>Features</h4><ul><li>1-on-1 and group chat</li><li>Online/offline indicator</li><li>Message delivery receipts (sent, delivered, read)</li><li>Push notifications when offline</li><li>Message history</li></ul><h4>Scale</h4><ul><li>50M DAU, 10B messages/day</li><li>Max group size: 500 members</li></ul>`,
          },
          {
            title: "Estimate Scale",
            content: `<ul><li>10B messages/day ≈ 116K/sec</li><li>Avg message size = 100 bytes → 1TB/day new data</li><li>50M concurrent WS connections</li></ul><p><span class="highlight">Challenge: Maintain persistent connections for all online users</span></p>`,
          },
          {
            title: "High-Level Design",
            content: `<div class="arch-diagram">Client ←→ WS Gateway (stateful) ←→ Chat Service
                                                       ↓                    ↓
                                              Presence Service       Message Store (Cassandra)
                                                       ↓                    ↓
                                              Redis (online set)    Push Notification Service</div>`,
          },
          {
            title: "Deep Dive",
            content: `<h4>WebSocket Gateway</h4><ul><li>Stateful — each server holds open WS connections for subset of users</li><li>Service Discovery: ZooKeeper or Redis maps user_id → WS server</li><li>Message routing: Sender's server → Kafka → recipient's WS server</li></ul><h4>Message Storage</h4><ul><li>Cassandra: partition key = channel_id, clustering key = message_id (time-ordered Snowflake ID)</li><li>Fast range scans, high write throughput</li></ul>`,
          },
          {
            title: "Trade-offs",
            content: `<ul><li><strong>Sync vs Async delivery</strong>: Kafka decouples sender/receiver servers. Enables replay.</li><li><strong>Offline messages</strong>: Store in DB. Push notification triggers client sync on reconnect.</li><li><strong>Receipts</strong>: Delivered = WS ack. Read = client sends explicit event.</li><li><strong>E2E Encryption</strong>: Keys managed on client. Server only sees encrypted blobs.</li></ul>`,
          },
        ],
      },
      {
        id: "rate-limiter",
        title: "Design a Rate Limiter",
        difficulty: "medium",
        tags: ["Redis", "API Gateway", "Distributed"],
        steps: [
          {
            title: "Clarify Requirements",
            content: `<ul><li>Limit requests per user/IP per time window</li><li>Return 429 Too Many Requests when exceeded</li><li>Rules: 100 req/min per user, 1000 req/min per IP</li><li>Distributed (multiple API servers)</li><li>Low latency (must not slow API)</li></ul>`,
          },
          {
            title: "Estimate Scale",
            content: `<ul><li>10K API servers, each handling 10K RPS = 100M RPS total</li><li>Need: atomic, distributed counter with TTL</li><li>In-process won't work across instances → need shared store</li></ul>`,
          },
          {
            title: "High-Level Design",
            content: `<div class="arch-diagram">Client → API Gateway (rate check) → Backend Service
                              ↕
                        Redis Cluster (counters)
                              ↕
                        Rules DB (configurable limits)</div>`,
          },
          {
            title: "Deep Dive",
            content: `<h4>Algorithms</h4>
            <p><strong>Token Bucket</strong>: Tokens refill at fixed rate. Allow bursts up to bucket size. Simple, widely used.</p>
            <p><strong>Sliding Window Log</strong>: Log each request timestamp. Count in window. Accurate but memory-heavy.</p>
            <p><strong>Sliding Window Counter</strong>: Hybrid — uses current + previous window weighted count. Memory-efficient.</p>
            <h4>Redis Implementation</h4>
            <p>Use Lua script for atomic increment+TTL: prevents race condition between INCR and EXPIRE.</p>`,
          },
          {
            title: "Trade-offs",
            content: `<ul><li><strong>Where?</strong> API Gateway (centralised) vs. Middleware (flexible). Gateway reduces app code.</li><li><strong>Distributed sync</strong>: Redis as central store. With Redis Cluster, use consistent hashing to same shard per key.</li><li><strong>Headers</strong>: Return X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After.</li><li><strong>Soft limits</strong>: Log violations before enforcing — prevents false positives on launch.</li></ul>`,
          },
        ],
      },
      {
        id: "notification-system",
        title: "Design Push Notification System",
        difficulty: "medium",
        tags: ["Message Queue", "Fan-out", "Mobile"],
        steps: [
          {
            title: "Clarify Requirements",
            content: `<ul><li>Push (iOS/Android), Email, SMS notifications</li><li>Delivery guarantee: at-least-once</li><li>High volume: 10M notifications/day</li><li>User notification preferences</li><li>Analytics: delivery, open rates</li></ul>`,
          },
          {
            title: "Estimate Scale",
            content: `<ul><li>10M/day ≈ 116/sec (but bursty — campaigns send all at once)</li><li>Peak: 100K/sec during flash sales</li><li>Need: horizontal scaling + queue for durability</li></ul>`,
          },
          {
            title: "High-Level Design",
            content: `<div class="arch-diagram">Event Source → Notification Service → Kafka Topics
                                                    ↓                ↓         ↓
                                              Push Workers    Email Workers   SMS Workers
                                                    ↓                ↓         ↓
                                              APNs/FCM         SES/SendGrid   Twilio</div>`,
          },
          {
            title: "Deep Dive",
            content: `<h4>Device Token Management</h4><ul><li>Store {user_id → [device_tokens]} in DB</li><li>Handle token rotation (refresh on app launch)</li><li>Invalidate stale tokens (APNs/FCM indicate invalid tokens in response)</li></ul><h4>Delivery Workers</h4><ul><li>One Kafka topic per channel (push/email/sms)</li><li>Workers consume, call provider, track status</li><li>Retry with exponential backoff on failure</li></ul>`,
          },
          {
            title: "Trade-offs",
            content: `<ul><li><strong>At-least-once vs exactly-once</strong>: At-least-once is simpler. Make notifications idempotent (dedup_id).</li><li><strong>User preferences</strong>: Check preference store before sending. Cache aggressively.</li><li><strong>Analytics</strong>: Pixel tracking for email opens. SDK callbacks for push opens. Stream to analytics DB.</li><li><strong>Priority queue</strong>: Transactional > Marketing. Separate Kafka topics with consumer priority.</li></ul>`,
          },
        ],
      },
      {
        id: "search-autocomplete",
        title: "Design Search Autocomplete",
        difficulty: "medium",
        tags: ["Trie", "Cache", "Ranking"],
        steps: [
          {
            title: "Clarify Requirements",
            content: `<ul><li>Top 10 suggestions as user types</li><li>5 queries/sec per user globally (Google scale: 10M QPS)</li><li>Latency: &lt;100ms end-to-end</li><li>Suggestions ranked by popularity</li><li>Update suggestions weekly (or near-realtime)</li></ul>`,
          },
          {
            title: "High-Level Design",
            content: `<div class="arch-diagram">Browser (debounce 150ms) → CDN → LB → Autocomplete Service → Trie Cache (Redis)
                                                                                                       ↓
                                                                                               Search Log DB
                                                                                                       ↓
                                                                                           Weekly Trie Builder (batch)</div>`,
          },
          {
            title: "Deep Dive",
            content: `<h4>Data Structure: Trie</h4><ul><li>Each node = one char. Path from root = prefix. Leaf/node stores top-k queries.</li><li>Serialise Trie → Redis (or memcached) for fast reads</li><li>Pre-compute top-k at each node (trade memory for speed)</li></ul><h4>Ranking</h4><ul><li>Weight = frequency × recency decay</li><li>Rebuild trie weekly from search logs</li></ul>`,
          },
          {
            title: "Trade-offs",
            content: `<ul><li><strong>Trie vs Elasticsearch</strong>: Trie = faster prefix lookup. ES = more flexible (fuzzy, multi-lingual). Google uses Trie.</li><li><strong>Cache invalidation</strong>: Trie is rebuilt periodically, not real-time. Acceptable for most systems.</li><li><strong>Personalisation</strong>: Add user-specific boost as 2nd layer after global trie results.</li><li><strong>Multi-language</strong>: Separate trie per language/locale.</li></ul>`,
          },
        ],
      },
      {
        id: "ride-sharing",
        title: "Design a Ride-Sharing App (Uber)",
        difficulty: "hard",
        tags: ["Geospatial", "WebSocket", "Matching"],
        steps: [
          {
            title: "Clarify Requirements",
            content: `<ul><li>Rider requests ride at location A → B</li><li>Match nearby available driver</li><li>Real-time driver location tracking</li><li>ETA estimation</li><li>10M DAU, 1M concurrent trips</li></ul>`,
          },
          {
            title: "High-Level Design",
            content: `<div class="arch-diagram">Rider app → Ride Service → Matching Service → Driver location store (Redis GEO)
              Driver app → Location Service → Kafka → Redis GEO (driver positions)
              Both ←→ WebSocket Gateway (real-time tracking)</div>`,
          },
          {
            title: "Deep Dive",
            content: `<h4>Location Tracking</h4><ul><li>Drivers update location every 4 seconds via WebSocket</li><li>Redis GEO commands (GEOADD/GEORADIUS) — O(N+log M) range queries</li><li>Geohash cells for efficient proximity search</li></ul><h4>Matching Algorithm</h4><ul><li>Find drivers within R miles of rider → score by ETA + rating → dispatch top candidate</li><li>ETA: Google Maps API or internal routing engine</li></ul>`,
          },
          {
            title: "Trade-offs",
            content: `<ul><li><strong>Consistency of driver location</strong>: Eventual OK — 4s lag is acceptable</li><li><strong>Dispatch fairness</strong>: Don't just pick nearest — balance supply across city (heat maps)</li><li><strong>Surge pricing</strong>: Supply/demand ratio per geohash cell → dynamic multiplier</li><li><strong>Trip data</strong>: Cassandra for time-series GPS trail. S3 for archival.</li></ul>`,
          },
        ],
      },
      {
        id: "distributed-cache",
        title: "Design a Distributed Cache",
        difficulty: "hard",
        tags: ["Consistent Hashing", "Eviction", "Replication"],
        steps: [
          {
            title: "Clarify Requirements",
            content: `<ul><li>Key-value store (GET/SET/DELETE)</li><li>Sub-millisecond latency</li><li>Horizontal scalability (add nodes)</li><li>High availability (no SPOF)</li><li>Eviction policies (LRU, LFU, TTL)</li></ul>`,
          },
          {
            title: "High-Level Design",
            content: `<div class="arch-diagram">Client → Consistent Hash Ring → Cache Node 1..N
                              (each node has replica on clockwise neighbor)
                              Cache Node ←→ replication ←→ Replica Node</div>`,
          },
          {
            title: "Deep Dive",
            content: `<h4>Consistent Hashing</h4><ul><li>Hash key + hash node IDs onto ring</li><li>Key belongs to next clockwise node</li><li>Adding/removing node only remaps ~1/N keys (vs modulo hash = full remap)</li><li>Virtual nodes (vnodes): each physical node has 150 points on ring → more even distribution</li></ul><h4>Eviction</h4><ul><li>LRU: Doubly-linked list + hash map. O(1) get/put.</li><li>LFU: Min-heap on frequency. Better for skewed access patterns.</li></ul>`,
          },
          {
            title: "Trade-offs",
            content: `<ul><li><strong>Replication</strong>: Async replication to next N nodes. Strong consistency = sync (slower writes).</li><li><strong>Cache stampede</strong>: Many misses on same key → Dog-pile effect. Mitigate with mutex lock or probabilistic early expiry.</li><li><strong>Hot keys</strong>: Add random suffix → spread across multiple cache nodes → aggregate on read.</li></ul>`,
          },
        ],
      },
    ];

    let _activeProblem = null;
    let _activeStep = 0;

    function renderProblemList(containerEl) {
      containerEl.innerHTML = `
        <div class="aic-interview-problems">
          ${PROBLEMS.map(
            (p) => `
            <div class="aic-problem-card" data-id="${p.id}">
              <div class="aic-problem-title">${escHtml(p.title)}</div>
              <div class="aic-problem-tags">
                <span class="aic-problem-tag ${p.difficulty}">${p.difficulty}</span>
                ${p.tags.map((t) => `<span class="aic-problem-tag medium">${escHtml(t)}</span>`).join("")}
              </div>
            </div>`,
          ).join("")}
        </div>`;

      containerEl.querySelectorAll(".aic-problem-card").forEach((card) => {
        card.addEventListener("click", () =>
          startProblem(card.dataset.id, containerEl),
        );
      });
    }

    function startProblem(id, containerEl) {
      const problem = PROBLEMS.find((p) => p.id === id);
      if (!problem) return;
      _activeProblem = problem;
      _activeStep = 0;
      renderSession(containerEl);
    }

    function renderSession(containerEl) {
      const p = _activeProblem;
      const step = p.steps[_activeStep];

      containerEl.innerHTML = `
        <div style="display:flex;flex-direction:column;height:100%">
          <div class="aic-inter-header">
            <button class="aic-inter-back" id="aic-inter-back-btn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M19 12H5M12 5l-7 7 7 7"/>
              </svg>
            </button>
            <div class="aic-inter-title">${escHtml(p.title)}</div>
          </div>
          <div class="aic-inter-steps">
            ${p.steps
              .map(
                (s, i) => `
              <div class="aic-inter-step ${i === _activeStep ? "active" : i < _activeStep ? "done" : ""}"
                   data-step="${i}">${i + 1}. ${escHtml(s.title)}</div>`,
              )
              .join("")}
          </div>
          <div class="aic-inter-content" id="aic-inter-content">
            ${step.content}
          </div>
          <div class="aic-inter-nav">
            <button class="aic-action-btn" id="aic-step-prev" ${_activeStep === 0 ? "disabled" : ""}>← Prev</button>
            <span style="font-size:0.75rem;color:var(--text-muted);align-self:center">
              Step ${_activeStep + 1} / ${p.steps.length}
            </span>
            <button class="aic-action-btn primary" id="aic-step-next">
              ${_activeStep === p.steps.length - 1 ? "✓ Complete" : "Next →"}
            </button>
          </div>
        </div>`;

      containerEl
        .querySelector("#aic-inter-back-btn")
        .addEventListener("click", () => {
          _activeProblem = null;
          renderProblemList(containerEl);
        });
      containerEl.querySelectorAll(".aic-inter-step").forEach((s) => {
        s.addEventListener("click", () => {
          _activeStep = parseInt(s.dataset.step);
          renderSession(containerEl);
        });
      });
      const prevBtn = containerEl.querySelector("#aic-step-prev");
      const nextBtn = containerEl.querySelector("#aic-step-next");
      prevBtn?.addEventListener("click", () => {
        if (_activeStep > 0) {
          _activeStep--;
          renderSession(containerEl);
        }
      });
      nextBtn?.addEventListener("click", () => {
        if (_activeStep < p.steps.length - 1) {
          _activeStep++;
          renderSession(containerEl);
        } else {
          _activeProblem = null;
          renderProblemList(containerEl);
        }
      });
    }

    return { renderProblemList };
  })();

  // ── Architecture Diagram Suggester ───────────────────────────
  const DiagramSuggester = (() => {
    const DIAGRAMS = {
      "url shortener": {
        title: "URL Shortener Architecture",
        ascii: `┌─────────────────────────────────────────────────────┐
│                  URL SHORTENER SYSTEM                │
└─────────────────────────────────────────────────────┘

 Client ──► CDN (CloudFront) ──► ALB ──► API Service
                                              │
               ┌──────────────────────────────┤
               │                              │
        Redis Cache                    DynamoDB
      (hot short codes)             (short→long URL map)
       TTL: 24h hours                 Primary Key: short_code

 Write Flow:
   App ──► ID Generator (Snowflake) ──► Base62 ──► DynamoDB

 Read Flow:
   Client ──► CDN ──► Redis hit? ──► 301 Redirect
                        │ miss
                     DynamoDB ──► cache ──► Redirect`,
      },
      instagram: {
        title: "Instagram-like Feed",
        ascii: `┌─────────────────────────────────────────────────────┐
│                 SOCIAL FEED SYSTEM                   │
└─────────────────────────────────────────────────────┘

 WRITE PATH:
   Upload ──► Media Service ──► S3 ──► CloudFront CDN
                  │
                Kafka (post_created event)
                  │
           Fan-out Workers
          /              \\
   (normal users)    (celebrities)
   Push to Redis       Pull on read
   feed cache

 READ PATH:
   Client ──► Feed Service ──► Redis (pre-built feed)
                                  │ miss
                              Cassandra (post history)

 Tables:
   users(id, username, followers_count)
   posts(id, user_id, media_url, created_at)
   follows(follower_id, followee_id)
   feed_cache: Redis sorted set user:{id}:feed → [post_ids]`,
      },
      "rate limiter": {
        title: "Distributed Rate Limiter",
        ascii: `┌─────────────────────────────────────────────────────┐
│             DISTRIBUTED RATE LIMITER                 │
└─────────────────────────────────────────────────────┘

 Client Request
      │
      ▼
 API Gateway middleware
      │
      ├──► Redis (Atomic Lua script)
      │         INCR key:{user_id}:{window}
      │         if new key: EXPIRE 60 seconds
      │         return current_count
      │
      ├── count ≤ limit? ──► ✅ Forward to Backend
      │
      └── count > limit? ──► ❌ 429 Too Many Requests
                                  Retry-After: Xs

 Algorithms:
   Token Bucket   → allows bursts, smooth steady state
   Sliding Window → accurate, uses more memory
   Fixed Window   → simple, edge-case at boundary`,
      },
      "chat system": {
        title: "Real-time Chat System",
        ascii: `┌─────────────────────────────────────────────────────┐
│               CHAT SYSTEM ARCHITECTURE               │
└─────────────────────────────────────────────────────┘

 ┌─────────────┐        WebSocket        ┌─────────────────┐
 │  User A     │◄──────────────────────►│  WS Gateway #1  │
 └─────────────┘                         └────────┬────────┘
                                                   │
 ┌─────────────┐        WebSocket        ┌────────▼────────┐
 │  User B     │◄──────────────────────►│  WS Gateway #2  │
 └─────────────┘                         └────────┬────────┘
                                                   │
                                          ┌────────▼────────┐
                                          │  Kafka Topics   │
                                          │  (msg routing)  │
                                          └────────┬────────┘
                                                   │
                              ┌────────────────────┤
                              │                    │
                     ┌────────▼──────┐   ┌─────────▼──────┐
                     │  Cassandra    │   │  Redis          │
                     │  (msg store)  │   │  (online users) │
                     └───────────────┘   └────────────────┘`,
      },
      microservices: {
        title: "Microservices Architecture",
        ascii: `┌─────────────────────────────────────────────────────┐
│            MICROSERVICES ARCHITECTURE                │
└─────────────────────────────────────────────────────┘

 Client ──► API Gateway ──► Auth Service
                │                │ JWT validate
                ├──► User Service ──────────────────┐
                ├──► Product Service                 │
                ├──► Order Service ──► Kafka ──►     │
                └──► Payment Service       Notification Service

 Each service has its own DB (Database per Service pattern):
   User Service    ──► PostgreSQL (user data)
   Product Service ──► MongoDB (catalogue)
   Order Service   ──► MySQL (transactions - ACID)
   Notification    ──► Redis (ephemeral state)

 Communication:
   Sync  → REST/gRPC (request-response, low latency)
   Async → Kafka events (decoupled, resilient)`,
      },
      "notification system": {
        title: "Push Notification System",
        ascii: `┌─────────────────────────────────────────────────────┐
│           NOTIFICATION SYSTEM ARCHITECTURE           │
└─────────────────────────────────────────────────────┘

 Event Sources ──► Notification Service
 (Triggers:           │
  - Order placed       ├──► Kafka: push-topic  ──► Push Workers ──► FCM/APNs
  - Payment done       ├──► Kafka: email-topic ──► Email Workers ──► SES
  - Promo campaign)    └──► Kafka: sms-topic   ──► SMS Workers ──► Twilio

 Notification Service:
   1. Check user preferences (DB)
   2. Look up device tokens (Redis)
   3. Route to correct Kafka topic

 Device Token Store (Redis):
   user:{id}:devices → {ios: [tokens], android: [tokens]}

 Delivery tracking:
   DB: notification_id | user_id | status | sent_at | opened_at`,
      },
      cdn: {
        title: "CDN Architecture",
        ascii: `┌─────────────────────────────────────────────────────┐
│                  CDN ARCHITECTURE                    │
└─────────────────────────────────────────────────────┘

 User (Sydney) ──► DNS ──► Nearest Edge PoP (Sydney)
                               │ Cache HIT?
                               ├── YES ──► Return asset (~5ms)
                               └── NO  ──► Origin Pull
                                              │
                                      Origin Server (us-east-1)
                                              │
                                        S3 / Web Server
                                              │
                                       Cache at Edge (TTL)
                                              │
                                       Future requests served
                                       from Sydney edge ✅

 Cache-Control headers:
   Static assets: max-age=31536000 (1 year) + content hash in filename
   HTML:          no-cache (always validate)
   API:           no-store (never cache sensitive data)`,
      },
      "load balancer": {
        title: "Load Balancer Design",
        ascii: `┌─────────────────────────────────────────────────────┐
│               LOAD BALANCER ARCHITECTURE             │
└─────────────────────────────────────────────────────┘

 Clients
    │
 Route53 (DNS) ──► GeoDNS routes to nearest region
    │
 ALB (Layer 7 — HTTP/HTTPS aware)
    │  Routing rules: path-based, header-based, weighted
    ├──► Target Group A: API Servers (EC2 / ECS)
    ├──► Target Group B: Static Server
    └──► Target Group C: WebSocket Servers

 Health Checks:
   ALB sends GET /health every 30s
   Unhealthy threshold: 2 failures → remove from rotation
   Auto Scaling: CloudWatch alarm → scale out trigger

 Algorithms:
   Round Robin     → equal servers, stateless requests
   Least Conn      → long-lived connections (WS, streaming)
   Sticky Sessions → stateful apps (set via cookie)`,
      },
    };

    function render(containerEl, topicHint) {
      const input = containerEl.querySelector("#aic-diagram-input");
      const output = containerEl.querySelector("#aic-diagram-output");
      const topic = (topicHint || (input ? input.value : ""))
        .toLowerCase()
        .trim();

      if (!output) return;

      // fuzzy match
      const key = Object.keys(DIAGRAMS).find(
        (k) => topic.includes(k) || k.includes(topic),
      );
      if (key) {
        const d = DIAGRAMS[key];
        output.innerHTML = `<div style="color:var(--text-muted);font-size:0.68rem;margin-bottom:10px;font-style:italic">${d.title}</div>${escHtml(d.ascii)}`;
      } else if (topic) {
        output.textContent = `No diagram for "${topic}" yet. Try: ${Object.keys(DIAGRAMS).join(", ")}`;
      } else {
        output.textContent = "Enter a system name above and click Generate.";
      }
    }

    return { DIAGRAMS, render };
  })();

  // ── Daily Plan Generator ─────────────────────────────────────
  const DailyPlan = (() => {
    function generate(containerEl) {
      const topic =
        typeof LMS !== "undefined" && LMS.getTodayTopic
          ? LMS.getTodayTopic()
          : null;

      let morning = {
        meta: "Morning · 6:30 – 8:00 AM",
        topic: topic ? topic.title : "No topic scheduled",
        desc: topic
          ? `📖 Learn the concept: What is ${topic.title}? Why does it exist? Core mechanism.`
          : "Set up your study plan in the Planner panel.",
      };
      let evening = {
        meta: "Evening · 9:30 – 10:30 PM",
        topic: topic ? `Practice: ${topic.title}` : "Review",
        desc: topic
          ? `✏️ Recall without notes. Draw the flow. Write one real-world use case. Rate your confidence.`
          : "Review any pending topics from earlier in the week.",
      };

      containerEl.innerHTML = `
        <div class="aic-plan-session">
          <div class="aic-session-icon morning">🌅</div>
          <div>
            <div class="aic-session-meta">${morning.meta}</div>
            <div class="aic-session-topic">${escHtml(morning.topic)}</div>
            <div class="aic-session-desc">${morning.desc}</div>
          </div>
        </div>
        <div class="aic-plan-session">
          <div class="aic-session-icon evening">🌙</div>
          <div>
            <div class="aic-session-meta">${evening.meta}</div>
            <div class="aic-session-topic">${escHtml(evening.topic)}</div>
            <div class="aic-session-desc">${evening.desc}</div>
          </div>
        </div>
        ${
          topic
            ? `
        <div style="margin-top:12px">
          <div class="aic-confidence-label" style="font-size:0.7rem;color:var(--text-muted);margin-bottom:6px;">Mark today's confidence:</div>
          <div class="aic-confidence-row">
            <button class="aic-conf-btn" data-val="low">😕 Low</button>
            <button class="aic-conf-btn" data-val="medium">🙂 Medium</button>
            <button class="aic-conf-btn" data-val="high">💪 High</button>
          </div>
        </div>`
            : ""
        }`;

      containerEl.querySelectorAll(".aic-conf-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          containerEl
            .querySelectorAll(".aic-conf-btn")
            .forEach((b) => b.classList.remove("selected"));
          btn.classList.add("selected");
          if (topic) {
            WeakAreaDetector.saveConfidence(
              topic.subject || "general",
              topic.day || 0,
              btn.dataset.val,
            );
          }
        });
      });
    }

    return { generate };
  })();

  // ── Smart Reminder ───────────────────────────────────────────
  const Reminder = (() => {
    const REMIND_KEY = "aic_last_remind";

    function shouldShow() {
      if (typeof LMS === "undefined" || !LMS.getTodayTopic) return false;
      const topic = LMS.getTodayTopic();
      if (!topic || topic.status === "done") return false;

      const hour = new Date().getHours();
      // Show during evening study window (21-23) if today's topic not done
      if (hour < 21 || hour > 23) return false;

      // Don't show if dismissed today
      const last = sessionStorage.getItem(REMIND_KEY);
      if (last === new Date().toDateString()) return false;

      return true;
    }

    function show() {
      const popup = document.getElementById("aic-reminder-popup");
      if (!popup) return;
      const topic = LMS.getTodayTopic?.();
      if (!topic) return;

      popup.querySelector(".aic-popup-topic").textContent = topic.title;
      popup.classList.add("visible");
    }

    function dismiss() {
      const popup = document.getElementById("aic-reminder-popup");
      popup?.classList.remove("visible");
      sessionStorage.setItem(REMIND_KEY, new Date().toDateString());
    }

    function init() {
      const closeBtn = document.getElementById("aic-reminder-close");
      if (closeBtn) closeBtn.addEventListener("click", dismiss);
      const studyBtn = document.getElementById("aic-reminder-study");
      if (studyBtn)
        studyBtn.addEventListener("click", () => {
          dismiss();
          Nav?.show?.("planner");
        });

      if (shouldShow()) {
        setTimeout(show, 3000);
      }
    }

    return { init, show, dismiss };
  })();

  // ── Render panel ─────────────────────────────────────────────
  function render() {
    const panel = document.getElementById("panel-aicoach");
    if (!panel) return;

    const topic =
      typeof LMS !== "undefined" && LMS.getTodayTopic
        ? LMS.getTodayTopic()
        : null;
    const topicDone = topic && topic.status === "done";

    panel.innerHTML = `
      <div class="panel-inner">
        <div class="aic-panel-header-row">
          <div class="aic-brand-dot">🧠</div>
          <div>
            <div style="font-size:1.35rem;font-weight:800;color:var(--text-primary);letter-spacing:-0.02em">
              AI Learning Coach
            </div>
            <div style="font-size:0.8rem;color:var(--text-muted);margin-top:2px">
              Your personal backend & system design tutor
            </div>
          </div>
        </div>

        ${
          !topicDone
            ? `
        <div class="aic-reminder" id="aic-panel-reminder">
          <div class="aic-reminder-icon">⏰</div>
          <div class="aic-reminder-text">
            <div class="aic-reminder-title">Today's topic pending</div>
            <div class="aic-reminder-sub">${topic ? escHtml(topic.title) : "Open Planner to set today's plan"}</div>
          </div>
          <button class="aic-reminder-dismiss" onclick="Nav.show('planner')">Study Now</button>
        </div>`
            : `
        <div class="aic-reminder" style="animation:none;border-color:rgba(34,197,94,0.3);background:linear-gradient(135deg,rgba(34,197,94,0.1),rgba(34,197,94,0.04))">
          <div class="aic-reminder-icon">✅</div>
          <div class="aic-reminder-text">
            <div class="aic-reminder-title" style="color:#22c55e">Today's topic completed!</div>
            <div class="aic-reminder-sub">${escHtml(topic.title)} · Great work!</div>
          </div>
        </div>`
        }

        <div class="aic-grid">
          <div class="aic-card aic-daily-plan">
            <div class="aic-card-title">
              📅 Today's Study Plan
              <span class="aic-badge">AI Generated</span>
            </div>
            <div id="aic-daily-plan-content"></div>
          </div>

          <div class="aic-card">
            <div class="aic-card-title">
              📝 Revision Due
              <span class="aic-badge">Spaced Rep</span>
            </div>
            <div id="aic-revision-content" class="aic-revision-list"></div>
          </div>
        </div>

        <div class="aic-grid">
          <div class="aic-card">
            <div class="aic-card-title">
              🔍 Weak Areas
              <span class="aic-badge">Detected</span>
            </div>
            <div id="aic-weak-content" class="aic-weak-list"></div>
          </div>

          <div class="aic-card">
            <div class="aic-card-title">🏗️ Architecture Diagrams</div>
            <div class="aic-diagram-wrap">
              <div class="aic-diagram-topic-row">
                <input type="text" id="aic-diagram-input" class="aic-diagram-topic-input"
                  placeholder="e.g. URL shortener, CDN, chat system…" />
                <button class="aic-diagram-btn" id="aic-diagram-gen-btn">Generate</button>
              </div>
              <div class="aic-diagram-quick-btns">
                ${[
                  "url shortener",
                  "cdn",
                  "rate limiter",
                  "microservices",
                  "notification system",
                ]
                  .map(
                    (t) =>
                      `<button class="aic-quick-topic-btn" data-topic="${t}">${t}</button>`,
                  )
                  .join("")}
              </div>
              <div id="aic-diagram-output" class="aic-diagram-output">Enter a system name above and click Generate.</div>
            </div>
          </div>
        </div>

        <div class="aic-card" style="margin-bottom:24px">
          <div class="aic-card-title">
            🎯 System Design Interview Coach
            <span class="aic-badge">8 Problems</span>
          </div>
          <div id="aic-interview-content"></div>
        </div>

        <div class="aic-card" style="margin-bottom:24px">
          <div class="aic-card-title">
            💬 Quick Chat
            <span class="aic-badge">AI</span>
          </div>
          <div style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:12px">
            Ask me anything about your study topics, get explanations, or request diagrams.
          </div>
          <div class="aic-suggestions" style="padding:0;border:none">
            <button class="aic-suggestion" data-msg="explain JWT">Explain JWT</button>
            <button class="aic-suggestion" data-msg="explain Redis">Explain Redis</button>
            <button class="aic-suggestion" data-msg="what should I study today?">Today's Plan</button>
            <button class="aic-suggestion" data-msg="show my progress">My Progress</button>
            <button class="aic-suggestion" data-msg="motivate me">Motivate Me</button>
            <button class="aic-suggestion" data-msg="explain CAP theorem">CAP Theorem</button>
          </div>
          <button class="aic-action-btn primary" onclick="AICoach._openChat()" style="margin-top:12px">
            💬 Open Chat
          </button>
        </div>
      </div>`;

    // Wire up sub-panels
    DailyPlan.generate(document.getElementById("aic-daily-plan-content"));
    WeakAreaDetector.renderWeakList(
      document.getElementById("aic-weak-content"),
    );
    RevisionEngine.renderRevisionList(
      document.getElementById("aic-revision-content"),
    );
    InterviewCoach.renderProblemList(
      document.getElementById("aic-interview-content"),
    );

    // Diagram wiring
    const genBtn = document.getElementById("aic-diagram-gen-btn");
    const diagInput = document.getElementById("aic-diagram-input");
    const diagSection = document
      .getElementById("aic-diagram-output")
      ?.closest(".aic-card");
    if (genBtn)
      genBtn.addEventListener("click", () =>
        DiagramSuggester.render(genBtn.closest(".aic-card")),
      );
    if (diagInput)
      diagInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter")
          DiagramSuggester.render(diagInput.closest(".aic-card"));
      });
    document.querySelectorAll(".aic-quick-topic-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (diagInput) diagInput.value = btn.dataset.topic;
        DiagramSuggester.render(btn.closest(".aic-card"));
      });
    });

    // Quick chat chips (in panel)
    document
      .querySelectorAll("#panel-aicoach .aic-suggestion")
      .forEach((chip) => {
        chip.addEventListener("click", () => {
          Chat.sendMessage(chip.dataset.msg || chip.textContent);
          Chat.open();
        });
      });
  }

  // ── Public API helpers ───────────────────────────────────────
  function escHtml(s) {
    if (!s) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── Init ─────────────────────────────────────────────────────
  function init() {
    Chat.init();
    Reminder.init();
  }

  return {
    init,
    render,
    // exposed for inline onclick
    _openChat: () => Chat.open(),
    _markRevised: (key, btn) => {
      RevisionEngine.markReviewed(key);
      const item = btn.closest(".aic-revision-item");
      if (item) {
        item.style.opacity = "0.4";
        item.style.pointerEvents = "none";
        btn.textContent = "✓ Revised";
      }
    },
  };
})();
