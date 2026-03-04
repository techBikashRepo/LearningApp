/**
 * lms-topics.js — Full Learning Roadmap Topics Database
 * All 127 topics from the complete curriculum, in study order.
 * Each topic: { id, subject, category, title }
 */

const LMS_TOPICS = [
  // ── SUBJECT 01: Networking Fundamentals ────────────────────
  { id: 0, subject: "01 · Networking", title: "What is a Network" },
  { id: 1, subject: "01 · Networking", title: "LAN vs WAN vs Internet" },
  { id: 2, subject: "01 · Networking", title: "Public IP vs Private IP" },
  {
    id: 3,
    subject: "01 · Networking",
    title: "IP Address Structure — IPv4 Concept",
  },
  { id: 4, subject: "01 · Networking", title: "Ports & Sockets" },
  { id: 5, subject: "01 · Networking", title: "Router vs Switch" },
  { id: 6, subject: "01 · Networking", title: "Packets & Packet Switching" },
  { id: 7, subject: "01 · Networking", title: "DNS — What It Is" },
  {
    id: 8,
    subject: "01 · Networking",
    title: "DNS Resolution Flow Step by Step",
  },
  { id: 9, subject: "01 · Networking", title: "Domain Name vs IP Address" },
  { id: 10, subject: "01 · Networking", title: "TCP vs UDP" },
  { id: 11, subject: "01 · Networking", title: "TCP 3-Way Handshake" },
  {
    id: 12,
    subject: "01 · Networking",
    title: "TCP Reliability — ACK & Retransmission",
  },
  {
    id: 13,
    subject: "01 · Networking",
    title: "HTTP Protocol — Request & Response",
  },
  { id: 14, subject: "01 · Networking", title: "HTTP Methods" },
  { id: 15, subject: "01 · Networking", title: "HTTP Status Codes" },
  { id: 16, subject: "01 · Networking", title: "HTTP Headers" },
  { id: 17, subject: "01 · Networking", title: "Cookies vs Sessions" },
  { id: 18, subject: "01 · Networking", title: "HTTPS vs HTTP" },
  { id: 19, subject: "01 · Networking", title: "SSL/TLS Handshake" },
  { id: 20, subject: "01 · Networking", title: "CORS" },
  { id: 21, subject: "01 · Networking", title: "Request-Response Lifecycle" },
  {
    id: 22,
    subject: "01 · Networking",
    title: "Latency vs Bandwidth vs Throughput",
  },
  { id: 23, subject: "01 · Networking", title: "Round-Trip Time (RTT)" },
  {
    id: 24,
    subject: "01 · Networking",
    title: "Content Delivery Network (CDN)",
  },
  { id: 25, subject: "01 · Networking", title: "How the Web Works" },

  // ── SUBJECT 02: Backend API Design ─────────────────────────
  { id: 26, subject: "02 · API Design", title: "REST Architecture" },
  { id: 27, subject: "02 · API Design", title: "Resource Naming" },
  { id: 28, subject: "02 · API Design", title: "Path vs Query Parameters" },
  { id: 29, subject: "02 · API Design", title: "Idempotent Operations" },
  {
    id: 30,
    subject: "02 · API Design",
    title: "Pagination — Offset vs Cursor",
  },
  { id: 31, subject: "02 · API Design", title: "Filtering & Sorting" },
  { id: 32, subject: "02 · API Design", title: "API Versioning" },
  { id: 33, subject: "02 · API Design", title: "Standard Error Responses" },
  { id: 34, subject: "02 · API Design", title: "File Upload Flow" },
  { id: 35, subject: "02 · API Design", title: "Swagger / OpenAPI Basics" },

  // ── SUBJECT 03: Authentication & Security ──────────────────
  {
    id: 36,
    subject: "03 · Auth & Security",
    title: "Authentication vs Authorization",
  },
  { id: 37, subject: "03 · Auth & Security", title: "Session Authentication" },
  { id: 38, subject: "03 · Auth & Security", title: "JWT Authentication" },
  {
    id: 39,
    subject: "03 · Auth & Security",
    title: "Access Token vs Refresh Token",
  },
  {
    id: 40,
    subject: "03 · Auth & Security",
    title: "Password Hashing & Bcrypt",
  },
  { id: 41, subject: "03 · Auth & Security", title: "CSRF Attack" },
  { id: 42, subject: "03 · Auth & Security", title: "XSS Attack" },
  { id: 43, subject: "03 · Auth & Security", title: "Input Validation" },
  { id: 44, subject: "03 · Auth & Security", title: "Login Rate Limiting" },

  // ── SUBJECT 04: Databases & Data Modeling ──────────────────
  {
    id: 45,
    subject: "04 · Databases",
    title: "Database Basics — Tables & Schema",
  },
  { id: 46, subject: "04 · Databases", title: "SELECT & WHERE" },
  { id: 47, subject: "04 · Databases", title: "ORDER BY" },
  { id: 48, subject: "04 · Databases", title: "GROUP BY & HAVING" },
  {
    id: 49,
    subject: "04 · Databases",
    title: "Aggregations — COUNT, SUM, AVG",
  },
  { id: 50, subject: "04 · Databases", title: "Primary Key" },
  { id: 51, subject: "04 · Databases", title: "Foreign Key" },
  { id: 52, subject: "04 · Databases", title: "JOINs — INNER & LEFT" },
  { id: 53, subject: "04 · Databases", title: "Many-to-Many Relationships" },
  {
    id: 54,
    subject: "04 · Databases",
    title: "Constraints — NOT NULL, UNIQUE, DEFAULT",
  },
  { id: 55, subject: "04 · Databases", title: "Indexing — Why Queries Slow" },
  { id: 56, subject: "04 · Databases", title: "B-Tree Index" },
  { id: 57, subject: "04 · Databases", title: "Composite Index" },
  { id: 58, subject: "04 · Databases", title: "When NOT to Index" },
  { id: 59, subject: "04 · Databases", title: "Transactions" },
  { id: 60, subject: "04 · Databases", title: "ACID Properties" },
  { id: 61, subject: "04 · Databases", title: "Race Conditions" },
  { id: 62, subject: "04 · Databases", title: "Prevent Duplicate Payments" },
  { id: 63, subject: "04 · Databases", title: "Normalization" },
  { id: 64, subject: "04 · Databases", title: "Denormalization" },
  { id: 65, subject: "04 · Databases", title: "Soft Delete" },
  { id: 66, subject: "04 · Databases", title: "Audit Columns" },
  { id: 67, subject: "04 · Databases", title: "Multi-Tenant Data" },
  { id: 68, subject: "04 · Databases", title: "N+1 Query Problem" },
  { id: 69, subject: "04 · Databases", title: "EXPLAIN ANALYZE" },

  // ── SUBJECT 05: System Design & Architecture ───────────────
  { id: 70, subject: "05 · System Design", title: "Monolith vs Microservices" },
  { id: 71, subject: "05 · System Design", title: "Layered Architecture" },
  {
    id: 72,
    subject: "05 · System Design",
    title: "Controller–Service–Repository Pattern",
  },
  { id: 73, subject: "05 · System Design", title: "Clean Architecture Basics" },
  {
    id: 74,
    subject: "05 · System Design",
    title: "Backend for Frontend (BFF)",
  },
  { id: 75, subject: "05 · System Design", title: "API Gateway" },

  // ── SUBJECT 06: Scalability & Performance ──────────────────
  {
    id: 76,
    subject: "06 · Scalability",
    title: "Vertical vs Horizontal Scaling",
  },
  { id: 77, subject: "06 · Scalability", title: "Stateless Servers" },
  { id: 78, subject: "06 · Scalability", title: "Sticky Sessions" },
  { id: 79, subject: "06 · Scalability", title: "Load Balancers" },
  {
    id: 80,
    subject: "06 · Scalability",
    title: "Throughput vs Latency — Architect View",
  },
  { id: 81, subject: "06 · Scalability", title: "Caching & Redis" },
  { id: 82, subject: "06 · Scalability", title: "Cache-Aside Pattern" },
  { id: 83, subject: "06 · Scalability", title: "Write-Through vs Write-Back" },
  { id: 84, subject: "06 · Scalability", title: "Cache Invalidation" },
  { id: 85, subject: "06 · Scalability", title: "TTL Strategy" },
  { id: 86, subject: "06 · Scalability", title: "Redis Basics" },
  { id: 87, subject: "06 · Scalability", title: "Key-Value Storage" },
  { id: 88, subject: "06 · Scalability", title: "API Caching" },
  { id: 89, subject: "06 · Scalability", title: "Session Storage" },

  // ── SUBJECT 09: AWS Cloud Deployment ───────────────────────
  { id: 90, subject: "09 · AWS Deploy", title: "Linux Basics & SSH" },
  { id: 91, subject: "09 · AWS Deploy", title: "Environment Variables" },
  { id: 92, subject: "09 · AWS Deploy", title: "Nginx — Reverse Proxy" },
  { id: 93, subject: "09 · AWS Deploy", title: "Domain Setup" },
  { id: 94, subject: "09 · AWS Deploy", title: "HTTPS Setup" },

  // ── SUBJECT 10: AWS Core ────────────────────────────────────
  {
    id: 95,
    subject: "10 · AWS Core",
    title: "AWS Global Infrastructure — Regions & AZs",
  },
  { id: 96, subject: "10 · AWS Core", title: "VPC — Virtual Private Cloud" },
  { id: 97, subject: "10 · AWS Core", title: "Subnets — Public vs Private" },
  { id: 98, subject: "10 · AWS Core", title: "Internet Gateway" },
  { id: 99, subject: "10 · AWS Core", title: "Security Groups" },
  { id: 100, subject: "10 · AWS Core", title: "Network ACL" },
  { id: 101, subject: "10 · AWS Core", title: "EC2" },
  { id: 102, subject: "10 · AWS Core", title: "Elastic IP" },
  { id: 103, subject: "10 · AWS Core", title: "S3" },
  { id: 104, subject: "10 · AWS Core", title: "Pre-Signed URLs" },
  { id: 105, subject: "10 · AWS Core", title: "RDS — PostgreSQL" },
  { id: 106, subject: "10 · AWS Core", title: "Connection Pooling" },
  {
    id: 107,
    subject: "10 · AWS Core",
    title: "Networking, Ports & Firewall in AWS",
  },

  // ── SUBJECT 11: Containers & Deployment ────────────────────
  { id: 108, subject: "11 · Containers", title: "Docker Concepts" },
  { id: 109, subject: "11 · Containers", title: "Dockerfile" },
  { id: 110, subject: "11 · Containers", title: "Containers vs Images" },
  { id: 111, subject: "11 · Containers", title: "Docker Compose" },
  { id: 112, subject: "11 · Containers", title: "Environment Configuration" },

  // ── SUBJECT 12: Production Engineering ─────────────────────
  { id: 113, subject: "12 · Production", title: "Centralized Logging" },
  { id: 114, subject: "12 · Production", title: "Monitoring" },
  { id: 115, subject: "12 · Production", title: "Health Checks" },
  { id: 116, subject: "12 · Production", title: "Graceful Shutdown" },
  {
    id: 117,
    subject: "12 · Production",
    title: "DB Connection Pooling — Production View",
  },
  { id: 118, subject: "12 · Production", title: "Retry Failed Calls" },
  { id: 119, subject: "12 · Production", title: "Secrets Management" },
  { id: 120, subject: "12 · Production", title: "Configuration Management" },
  { id: 121, subject: "12 · Production", title: "Backup Strategy" },
  { id: 122, subject: "12 · Production", title: "Basic CI/CD" },

  // ── SUBJECT 13: Architecture & Career Readiness ─────────────
  {
    id: 123,
    subject: "13 · Architecture",
    title: "System Architecture Diagrams",
  },
  {
    id: 124,
    subject: "13 · Architecture",
    title: "Architecture Decision Records (ADR)",
  },
  { id: 125, subject: "13 · Architecture", title: "Explaining Tradeoffs" },
  {
    id: 126,
    subject: "13 · Architecture",
    title: "Estimation & Task Breakdown",
  },
];
