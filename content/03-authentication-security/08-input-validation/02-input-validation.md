# Input Validation — Part 2 of 3

### Sections: 5 (Defense Mechanisms), 6 (Architecture Diagram), 7 (Production Scenarios), 8 (AWS Mapping)

**Series:** Authentication & Security → Topic 08

---

## SECTION 5 — Defense Mechanisms

### Defense 1: Zod Schema Validation (Validation at the Edge)

```javascript
// Validate ALL inputs at the entry point — before they reach business logic.
// Reject anything that doesn't conform to the expected schema.

import { z } from "zod";

// ─── USER REGISTRATION ─────────────────────────────────────────────────────
export const RegisterSchema = z.object({
  email: z
    .string()
    .email()
    .max(254) // RFC 5321 max email length
    .transform((e) => e.toLowerCase().trim()),

  username: z
    .string()
    .min(3)
    .max(30)
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Username may only contain letters, numbers, _ and -",
    ),

  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(72, "Password may not exceed 72 characters"), // bcrypt 72-char limit

  age: z.number().int().min(13).max(120).optional(),
});

// ─── PAGINATION/SORTING ────────────────────────────────────────────────────
export const ListUsersSchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.enum(["username", "created_at", "email"]).default("created_at"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});
// z.enum: allowlist approach. Any other value rejected.
// Prevents: sortBy = "id; DROP TABLE users"

// ─── FILE UPLOAD ─────────────────────────────────────────────────────────
export const FileUploadSchema = z.object({
  filename: z
    .string()
    .max(255)
    .regex(/^[a-zA-Z0-9._-]+$/) // No path separators
    .refine((n) => !n.includes(".."), { message: "Invalid filename" }),

  mimeType: z.enum([
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/pdf",
  ]),

  size: z
    .number()
    .int()
    .max(10 * 1024 * 1024), // Max 10MB
});

// ─── VALIDATION MIDDLEWARE FACTORY ─────────────────────────────────────────
function validate(schema, source = "body") {
  return (req, res, next) => {
    const data =
      source === "body"
        ? req.body
        : source === "query"
          ? req.query
          : req.params;

    const result = schema.safeParse(data);

    if (!result.success) {
      return res.status(400).json({
        error: "VALIDATION_FAILED",
        // fieldErrors exposes WHAT was wrong without exposing submitted values
        fields: result.error.flatten().fieldErrors,
      });
    }

    // Replace with validated/transformed data
    if (source === "body") req.body = result.data;
    else if (source === "query") req.query = result.data;
    else req.params = result.data;

    next();
  };
}

// USAGE:
app.post("/auth/register", validate(RegisterSchema), registerHandler);
app.get("/admin/users", validate(ListUsersSchema, "query"), listUsersHandler);
```

### Defense 2: Allowlist vs Denylist Philosophy

```javascript
// DENYLIST APPROACH (WEAK — avoid):
function sanitizeInput(input) {
  return input
    .replace(/'/g, "") // Remove single quotes
    .replace(/;/g, "") // Remove semicolons
    .replace(/--/g, "") // Remove SQL comments
    .replace(/<script/gi, ""); // Remove script tags
}
// PROBLEMS:
// * Attackers bypass: use other attack vectors not in your list
// * Unicode escapes: ' (unicode 2019) → works like ' in many contexts
// * Encoding tricks: %27 → ' (URL decode after your filter)
// * Incomplete: you WILL miss something. The attack surface is infinite.

// ALLOWLIST APPROACH (STRONG):
function validateUsername(input) {
  // ONLY allow: letters, numbers, underscore, hyphen
  // Length: 3-30 characters
  // EVERYTHING ELSE: rejected
  const ALLOWED = /^[a-zA-Z0-9_-]{3,30}$/;
  return ALLOWED.test(input);
}
// If it doesn't match what you expect: REJECT.
// Attacker: must find a payload using only [a-zA-Z0-9_-] → nearly impossible.
// New attack techniques discovered tomorrow: still blocked by your allowlist.

// STRUCTURAL VALIDATION + ALLOWLIST:
const UUIDSchema = z.string().uuid();
const NumericIdSchema = z.coerce.number().int().positive();
const SlugSchema = z
  .string()
  .regex(/^[a-z0-9-]+$/)
  .max(100);
const DateSchema = z.string().datetime(); // ISO 8601 only
const EnumSchema = z.enum(["status1", "status2"]); // Only known values
```

### Defense 3: Parameterized Queries + ORM Safety Rules

```javascript
// PARAMETERIZED QUERIES — full reference
// Rule: every dynamic value is a parameter, never concatenated.

// ─── POSTGRESQL (pg module) ─────────────────────────────────────────────
const result = await client.query(
  "SELECT id, username, email FROM users WHERE id = $1 AND active = $2",
  [userId, true], // always an array of parameters
);

// ─── MYSQL (mysql2) ─────────────────────────────────────────────────────
const [rows] = await pool.execute(
  "SELECT id FROM sessions WHERE token = ? AND expires_at > NOW()",
  [token],
);

// ─── DYNAMIC COLUMN ORDER (allowlist required) ─────────────────────────
// Column names and table names CANNOT be parameterized.
// They must come from a whitelist.
const SORT_COLUMNS = {
  username: "username",
  email: "email",
  created_at: "created_at",
};
const sortCol = SORT_COLUMNS[req.query.sortBy] ?? "created_at";
const sortDir = req.query.sortDir === "asc" ? "ASC" : "DESC";
// Now sortCol and sortDir come from your code — never from user input directly.
const query = `SELECT * FROM users ORDER BY ${sortCol} ${sortDir}`; // Safe now

// ─── DRIZZLE ORM (type-safe by default) ────────────────────────────────
import { eq, and, gt } from "drizzle-orm";

const user = await db
  .select({
    id: users.id,
    email: users.email,
  })
  .from(users)
  .where(
    and(
      eq(users.id, userId), // All values are parameterized by the ORM
      eq(users.active, true),
    ),
  )
  .limit(1);

// DANGER ZONE EVEN WITH ORM:
// Raw SQL template literals without the sql tag function:
const badQuery = db.execute(`SELECT * FROM users WHERE name = '${name}'`); // DANGER

// Safe with sql tagged template:
const safeQuery = db.execute(sql`SELECT * FROM users WHERE name = ${name}`); // SAFE
```

### Defense 4: Request Size Limits and Content Type Enforcement

```javascript
// Large payloads: DoS vector or injection payload smuggling
// Wrong content-type: bypass validation that assumes JSON

app.use(
  express.json({
    limit: "10kb", // Reject bodies larger than 10KB
    strict: true, // Only accept arrays and objects (not bare strings)
    type: "application/json", // Only parse if Content-Type matches
  }),
);

app.use(
  express.urlencoded({
    extended: false, // Only simple values — no nested objects via qs
    limit: "10kb",
    parameterLimit: 50, // Max 50 form parameters
  }),
);

// Explicit Content-Type validation middleware
function requireJsonContentType(req, res, next) {
  if (!["POST", "PUT", "PATCH"].includes(req.method)) return next();

  if (!req.is("application/json")) {
    return res.status(415).json({
      error: "UNSUPPORTED_MEDIA_TYPE",
      message: "Content-Type must be application/json",
    });
  }
  next();
}
```

---

## SECTION 6 — Architecture Diagram

```
INPUT VALIDATION ARCHITECTURE

CLIENT REQUEST
  POST /api/register
  Content-Type: application/json
  Body: { "username": "alice", "password": "...", "email": "..." }
                        │
                        ▼
AWS WAF
┌────────────────────────────────────────────────────────────────────────────────┐
│  SQL Injection managed rules: block patterns like ' OR '1'='1', UNION SELECT  │
│  XSS managed rules: block <script>, javascript:, onerror= patterns            │
│  Size restrictions: reject bodies > 8KB, URIs > 2KB                          │
│  Rate limiting: 100 req/min per IP                                            │
│  RESULT: obvious injection payloads blocked at CDN edge — before app server   │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    ▼
APPLICATION SERVER — MIDDLEWARE PIPELINE
┌────────────────────────────────────────────────────────────────────────────────┐
│  Step 1: helmet() — security headers                                           │
│  Step 2: express.json({ limit: '10kb' }) — parse + reject large bodies        │
│  Step 3: requireJsonContentType — reject non-JSON bodies on mutation routes   │
│  Step 4: Zod schema validation — type/format/length/pattern check              │
│          REJECT with 400 if any field fails validation                         │
│          TRANSFORM with validated data (e.g., email.toLowerCase())             │
│  Step 5: Authentication middleware (JWT/session check)                         │
│  Step 6: Authorization check (can this user perform this action?)              │
│  Step 7: Business logic handler                                                │
│                                                                                │
│  Validated data now flows to DB layer.                                         │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    ▼
DATABASE LAYER — PARAMETERIZED QUERIES
┌────────────────────────────────────────────────────────────────────────────────┐
│  All values passed as parameters — never concatenated into SQL string          │
│  DB user: least privilege (SELECT/INSERT/UPDATE on app tables only)            │
│           NO: DROP, CREATE, FILE privileges                                    │
│           NO: access to system tables (information_schema for production user) │
│  ORM: Drizzle/Prisma/TypeORM — all use parameterized queries by default        │
│  Raw queries: only with sql tagged template (never string concatenation)        │
└────────────────────────────────────────────────────────────────────────────────┘

ATTACKER FLOW (what gets blocked and where):
  Payload: { "username": "' OR '1'='1" }

  WAF: May not catch (SQL injection in JSON body vs URL — WAF rules vary)
  Zod: .regex(/^[a-zA-Z0-9_-]{3,30}$/) → REJECTS immediately → 400 returned
  If somehow passed Zod: parameterized query treats value as DATA → SQL injection fails
  Result: 3 layers — Zod + parameterized queries = injection impossible
```

---

## SECTION 7 — Production Scenarios

### Scenario 1: The Dynamic Query Builder Gone Wrong

```
COMPANY: AnalyticsDash — a SaaS dashboard allowing users to filter data tables.

FEATURE: Users can select any column to filter results.
IMPLEMENTATION (WRONG):

app.get('/api/reports/filter', authenticate, async (req, res) => {
  const { column, value, table } = req.query;

  // "Can't parameterize column/table names, so we build the query dynamically"
  const query = `SELECT * FROM ${table} WHERE ${column} = '${value}'`;
  const result = await db.query(query);
  res.json(result);
});

ATTACK:
  table = "users"
  column = "username' OR '1'='1' -- "
  value = "x"

  Constructed: SELECT * FROM users WHERE username' OR '1'='1' -- = 'x'
  → Returns all rows from users table.

  Further:
  table = "users UNION SELECT password_hash, email, null, null FROM users --"
  column = "id"
  value = "1"
  → Returns all hashed passwords.

  Even further with table:
  table = "users; DROP TABLE users; --"

ACTUAL FIX:
  // NEVER allow table name from user input. Hard-code allowed tables.
  const ALLOWED_TABLES = {
    'sales': 'sales_data',
    'products': 'product_catalog',
    'orders': 'order_history',
  };

  const ALLOWED_COLUMNS = {
    sales: ['date', 'amount', 'product_id', 'region'],
    products: ['name', 'category', 'price', 'in_stock'],
    orders: ['created_at', 'status', 'total', 'customer_id'],
  };

  app.get('/api/reports/filter', authenticate, async (req, res) => {
    const { table: tableKey, column, value } = req.query;

    const tableName = ALLOWED_TABLES[tableKey];
    if (!tableName) return res.status(400).json({ error: 'INVALID_TABLE' });

    const allowedCols = ALLOWED_COLUMNS[tableKey];
    if (!allowedCols.includes(column)) return res.status(400).json({ error: 'INVALID_COLUMN' });

    // Only value is from user input and it's parameterized
    const result = await db.query(`SELECT * FROM ${tableName} WHERE ${column} = $1`, [value]);
    res.json(result);
  });
```

### Scenario 2: File Upload Path Traversal Leading to Arbitrary File Overwrite

```
COMPANY: DocStorage — a document management SaaS.

FEATURE: Users can upload files and specify a "sub-folder" for organization.
IMPLEMENTATION (WRONG):

app.post('/api/files/upload', authenticate, upload.single('file'), (req, res) => {
  const { folder } = req.body;
  const filename = req.file.originalname;

  const destPath = path.join('/app/uploads/', req.user.id, folder, filename);
  fs.renameSync(req.file.path, destPath);
  res.json({ path: destPath });
});

ATTACK:
  folder = "../../../app/static"
  filename = "malicious.js"

  destPath = path.join('/app/uploads/user123/../../../app/static/malicious.js')
  path.join resolves: /app/static/malicious.js

  User uploaded a JavaScript file to the static assets directory.
  Next time any user loads /static/malicious.js → served by the server → executes XSS for all.

  More dangerous:
  filename = "../server.js"  → overwrites application code
  filename = "../.env"       → overwrites environment config

ACTUAL FIX:
  app.post('/api/files/upload', authenticate, upload.single('file'), (req, res) => {
    const folder = req.body.folder;

    // 1. Validate folder name (allowlist chars)
    if (!/^[a-zA-Z0-9_-]{0,50}$/.test(folder)) {
      return res.status(400).json({ error: 'INVALID_FOLDER' });
    }

    // 2. Generate safe filename — never use user's original filename directly
    const safeFilename = `${uuidv4()}-${Date.now()}`;
    // Store original name in DB, use UUID on disk

    // 3. Resolve and confine to upload directory
    const BASE_DIR = path.resolve('/app/uploads');
    const userDir = path.resolve(BASE_DIR, req.user.id, folder);

    if (!userDir.startsWith(BASE_DIR)) {
      return res.status(403).json({ error: 'ACCESS_DENIED' });
    }

    // 4. Create directory if needed, move file
    fs.mkdirSync(userDir, { recursive: true });
    fs.renameSync(req.file.path, path.join(userDir, safeFilename));
  });
```

---

## SECTION 8 — AWS Mapping

### AWS Services for Input Validation

```
┌──────────────────────────┬────────────────────────────────────────────────────────┐
│ AWS Service              │ Role in Input Validation                               │
├──────────────────────────┼────────────────────────────────────────────────────────┤
│ AWS WAF                  │ Layer 7 inspection at CDN edge                        │
│                          │ AWSManagedRulesSQLiRuleSet: block SQL injection        │
│                          │ AWSManagedRulesCommonRuleSet: XSS + many injections   │
│                          │ Body size restrictions: reject bodies > configured max │
│                          │ URI path restrictions: block path traversal attempts  │
│                          │ Custom rules: company-specific input patterns          │
├──────────────────────────┼────────────────────────────────────────────────────────┤
│ API Gateway              │ Input validation at API layer (before Lambda)          │
│                          │ Request validators: validate headers, query params,    │
│                          │   request body against JSON Schema models             │
│                          │ Throttling: reject bursts (layer against fuzzing)     │
├──────────────────────────┼────────────────────────────────────────────────────────┤
│ Lambda                   │ Small validation functions per route                  │
│                          │ Zod/Joi validation runs in Lambda before RDS access   │
│                          │ DB access: IAM auth (no password in code)             │
├──────────────────────────┼────────────────────────────────────────────────────────┤
│ RDS + IAM Auth           │ Parameterized queries via RDS Data API               │
│                          │ DB user: least privilege (no DROP/CREATE/FILE)        │
│                          │ RDS Proxy: connection pooling + IAM-based auth        │
├──────────────────────────┼────────────────────────────────────────────────────────┤
│ CloudWatch + GuardDuty   │ SQL injection pattern alerts: CloudWatch metric filter │
│                          │ RDS Performance Insights: detect unusual query patterns│
│                          │ GuardDuty: UnauthorizedAccess:RDS/MaliciousIPCaller   │
└──────────────────────────┴────────────────────────────────────────────────────────┘
```

### API Gateway Request Validation with JSON Schema

```json
{
  "RequestValidatorId": "validator-id",
  "ValidateRequestBody": true,
  "ValidateRequestParameters": true
}
```

```json
{
  "RegisterRequest": {
    "type": "object",
    "required": ["email", "username", "password"],
    "additionalProperties": false,
    "properties": {
      "email": {
        "type": "string",
        "format": "email",
        "maxLength": 254
      },
      "username": {
        "type": "string",
        "minLength": 3,
        "maxLength": 30,
        "pattern": "^[a-zA-Z0-9_-]+$"
      },
      "password": {
        "type": "string",
        "minLength": 8,
        "maxLength": 72
      }
    }
  }
}
```

### WAF SQL Injection + Size Rule Terraform

```hcl
resource "aws_wafv2_web_acl" "main" {
  name  = "app-waf"
  scope = "CLOUDFRONT"

  default_action { allow {} }

  rule {
    name     = "AWSManagedRulesSQLiRuleSet"
    priority = 10
    override_action { none {} }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesSQLiRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "SQLiRuleSetMetric"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "SizeRestrictions"
    priority = 20
    action { block {} }
    statement {
      size_constraint_statement {
        comparison_operator = "GT"
        size                = 10240  # 10KB
        field_to_match { body {} }
        text_transformation { priority = 0 type = "NONE" }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "SizeRestrictionMetric"
      sampled_requests_enabled   = true
    }
  }
}
```
