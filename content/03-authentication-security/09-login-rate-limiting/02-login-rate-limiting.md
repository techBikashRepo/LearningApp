# Login Rate Limiting — Part 2 of 3

### Sections: 5 (Defense Mechanisms), 6 (Architecture Diagram), 7 (Production Scenarios), 8 (AWS Mapping)

**Series:** Authentication & Security → Topic 09

---

## SECTION 5 — Defense Mechanisms

### Defense Layer 1: IP-Based Rate Limiting (Coarse Guard)

```javascript
// Express login router with full layered defense
// server/routes/auth.js

import express from "express";
import {
  ipRateLimiter,
  accountRateLimiter,
} from "../middleware/rate-limiter.js";
import { loginHandler } from "../handlers/login.js";
import { captchaRequired } from "../middleware/captcha.js";

const router = express.Router();

/**
 * Login route stack (order matters):
 *  1. IP rate limit: global throttle per source IP (blunt but cheap)
 *  2. Account rate limit: per-username throttle (precise, distributed-attack-resistant)
 *  3. Login handler: bcrypt compare + progressive delay
 */
router.post(
  "/login",
  ipRateLimiter, // 20 req/60s per IP → 429 if exceeded
  accountRateLimiter, // 5 fails/15min per email → 429 if exceeded
  loginHandler,
);

export default router;
```

### Defense Layer 2: Redis-Based Atomic Sliding Window (Production-Grade)

```javascript
// middleware/rate-limiter.js — Complete production implementation
import { createClient } from "redis";
import crypto from "crypto";

const redis = createClient({
  url: process.env.REDIS_URL,
  socket: { reconnectStrategy: (retries) => Math.min(retries * 50, 2000) },
});

await redis.connect();

/**
 * Lua script for atomic sliding window check.
 * Runs atomically in Redis (no race condition between processes).
 *
 * KEYS[1] = rate limit key
 * ARGV[1] = current timestamp (ms)
 * ARGV[2] = window start (now - windowMs)
 * ARGV[3] = max allowed
 * ARGV[4] = TTL in seconds
 *
 * Returns: { count, allowed }
 */
const SLIDING_WINDOW_LUA = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local window_start = tonumber(ARGV[2])
  local max = tonumber(ARGV[3])
  local ttl = tonumber(ARGV[4])
  
  -- Remove expired entries
  redis.call('ZREMRANGEBYSCORE', key, 0, window_start)
  
  -- Count current entries
  local count = redis.call('ZCARD', key)
  
  if count >= max then
    return {count, 0}  -- {count, allowed=0}
  end
  
  -- Add this request (unique score to allow same-millisecond entries)
  redis.call('ZADD', key, now, now .. ':' .. math.random(1, 1000000))
  redis.call('EXPIRE', key, ttl)
  
  return {count + 1, 1}  -- {count, allowed=1}
`;

async function checkRateLimit(key, max, windowMs) {
  const now = Date.now();
  const windowStart = now - windowMs;
  const ttl = Math.ceil(windowMs / 1000) + 1;

  try {
    const [count, allowed] = await redis.eval(SLIDING_WINDOW_LUA, {
      keys: [key],
      arguments: [String(now), String(windowStart), String(max), String(ttl)],
    });

    return {
      allowed: allowed === 1,
      remaining: Math.max(0, max - count),
    };
  } catch (err) {
    // Redis failure: fail OPEN (allow request) for UX,
    // or fail CLOSED (block request) for security-critical systems.
    // For login: fail OPEN with monitoring alert.
    console.error("[rate-limiter] Redis error (fail-open):", err.message);
    await notifyOpsTeam("rate-limiter-redis-failure", err);
    return { allowed: true, remaining: -1 }; // -1 signals "unknown, limiter down"
  }
}

function rateLimiter({ max, windowMs, keyFn }) {
  return async (req, res, next) => {
    const key = keyFn(req);
    const result = await checkRateLimit(key, max, windowMs);

    // Expose limits (NOT remaining — see Section 10 mistake #8)
    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Window-Seconds", Math.ceil(windowMs / 1000));

    if (!result.allowed) {
      return res.status(429).json({
        error: "RATE_LIMITED",
        message: "Too many login attempts. Please wait and try again.",
      });
    }

    next();
  };
}

// CONFIGURED LIMITERS:
export const ipRateLimiter = rateLimiter({
  max: 20,
  windowMs: 60_000, // 20 per minute per IP
  keyFn: (req) => `rl:ip:login:${req.ip}`,
});

export const accountRateLimiter = rateLimiter({
  max: 5,
  windowMs: 15 * 60_000, // 5 per 15 minutes per account
  keyFn: (req) => {
    const email = String(req.body?.email ?? "")
      .toLowerCase()
      .trim();
    // Hash email for privacy in Redis keys
    return `rl:acct:login:${crypto.createHash("sha256").update(email).digest("hex").slice(0, 16)}`;
  },
});
```

### Defense Layer 3: Progressive Delay + Account Lockout

```javascript
// handlers/login.js — Full production login handler with layered defense
import bcrypt from "bcrypt";
import { redis } from "../lib/redis.js";
import { sendAccountLockedEmail, sendUnlockEmail } from "../lib/email.js";
import { User } from "../models/user.js";
import { issueTokenPair } from "../lib/tokens.js";
import { verifyCaptcha } from "../lib/captcha.js";

// Sentinel hash: prevents timing attacks when user doesn't exist.
// Pre-generated with bcrypt.hash('dummy-password', 12)
const DUMMY_HASH = process.env.DUMMY_HASH; // Set this in Secrets Manager, never hardcode

const CONFIG = {
  maxSoftLock: 3, // Require CAPTCHA after 3 failures
  maxHardLock: 5, // Lock account after 5 failures
  lockDurationMs: 30 * 60_000, // 30-minute lockout
  progressiveDelays: [
    // ms of delay before responding, indexed by failure count
    0, 0, 1_000, 2_000, 4_000, 8_000,
  ],
};

export async function loginHandler(req, res) {
  const rawEmail = req.body?.email;
  const password = req.body?.password;
  const captchaToken = req.body?.captchaToken;

  // Zod validation already ran upstream (middleware)
  const email = String(rawEmail).toLowerCase().trim();
  const failKey = `login:fail:${email}`; // Per-account failure tracking

  // ------------------------------------------------------------------
  // 1. FAILURE COUNT CHECK
  // ------------------------------------------------------------------
  const failuresStr = await redis.get(failKey);
  const failures = parseInt(failuresStr ?? "0");

  if (failures >= CONFIG.maxHardLock) {
    const ttlMs = await redis.pttl(failKey);
    return res.status(423).json({
      error: "ACCOUNT_LOCKED",
      message:
        "Your account has been locked. Check your email for unlock instructions.",
      retryAfterSeconds: ttlMs > 0 ? Math.ceil(ttlMs / 1000) : 0,
    });
  }

  // ------------------------------------------------------------------
  // 2. CAPTCHA GATE at soft-lock threshold
  // ------------------------------------------------------------------
  if (failures >= CONFIG.maxSoftLock) {
    if (!captchaToken || !(await verifyCaptcha(captchaToken, req.ip))) {
      return res.status(400).json({
        error: "CAPTCHA_REQUIRED",
        message: "Please complete the CAPTCHA to continue.",
      });
    }
  }

  // ------------------------------------------------------------------
  // 3. PROGRESSIVE DELAY — slows automated tools
  // ------------------------------------------------------------------
  const delayMs =
    CONFIG.progressiveDelays[
      Math.min(failures, CONFIG.progressiveDelays.length - 1)
    ];
  if (delayMs > 0) {
    await new Promise((r) => setTimeout(r, delayMs));
  }

  // ------------------------------------------------------------------
  // 4. AUTHENTICATION
  // ------------------------------------------------------------------
  const user = await User.findByEmail(email);
  const hashToCompare = user?.passwordHash ?? DUMMY_HASH; // Timing attack prevention
  const isValid = await bcrypt.compare(password, hashToCompare);

  if (!user || !isValid) {
    // Increment failure counter
    const newFailures = await redis.incr(failKey);

    // Set/reset TTL on the failure key
    await redis.pexpire(failKey, CONFIG.lockDurationMs);

    // Notify user at first lockout threshold (not every failure)
    if (newFailures === CONFIG.maxHardLock && user) {
      const unlockToken = await generateUnlockToken(user.id);
      await sendAccountLockedEmail(user.email, unlockToken);
    }

    // Generic error — do NOT reveal whether email exists or password was wrong
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }

  // ------------------------------------------------------------------
  // 5. SUCCESS: reset failure counter + issue tokens
  // ------------------------------------------------------------------
  await redis.del(failKey);

  const { accessToken, refreshToken } = await issueTokenPair(user.id);

  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/auth",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });

  return res.json({ accessToken });
}

// ------------------------------------------------------------------
// UNLOCK ENDPOINT (email link: POST /auth/unlock?token=xxx)
// ------------------------------------------------------------------
export async function unlockHandler(req, res) {
  const { token } = req.query;
  const userId = await redeemUnlockToken(token); // Throws if invalid/expired

  if (!userId) {
    return res.status(400).json({ error: "INVALID_OR_EXPIRED_TOKEN" });
  }

  // Clear failure counter
  const user = await User.findById(userId);
  const failKey = `login:fail:${user.email}`;
  await redis.del(failKey);

  return res.json({ message: "Account unlocked. You may now log in." });
}
```

---

## SECTION 6 — Architecture Diagram

```
LOGIN RATE LIMITING — PRODUCTION ARCHITECTURE
==============================================

        INTERNET
            │
            │ POST /auth/login
            ▼
  ┌─────────────────────┐
  │   AWS CloudFront    │
  │   + WAF (L7)        │◄──── WAF Rule: ≥100 req/5min per IP → block
  │                     │      Rate-based rule (AWS managed)
  └──────────┬──────────┘
             │
             ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  APPLICATION SERVER (Node.js)                                       │
  │                                                                     │
  │  Middleware Pipeline:                                               │
  │                                                                     │
  │  [1] helmet() — security headers                                   │
  │       │                                                             │
  │  [2] express.json() — parse body                                   │
  │       │                                                             │
  │  [3] Zod validation — schema check (email format, types)           │
  │       │                                                             │
  │  [4] ipRateLimiter ─────────────────────────────────┐              │
  │       │  Check rl:ip:login:{ip} in Redis             │              │
  │       │  >20/60s? → 429 Too Many Requests            │              │
  │       │                                              │              │
  │  [5] accountRateLimiter ───────────────────┐        │              │
  │       │  Check rl:acct:login:{hash} in Redis│       │              │
  │       │  >5/15min? → 423 Account Locked     │       │              │
  │       │                                     │       │              │
  │  [6] loginHandler                           │       │              │
  │       │  failures ≥ 3? → require CAPTCHA    │       │              │
  │       │  Progressive delay (0→8sec)         │       │              │
  │       │  bcrypt.compare() (~300ms)          │       │              │
  │       │  FAIL → incr fail:email             │       │              │
  │       │  SUCCESS → del fail:email           │       │              │
  │       │  SUCCESS → issue tokens             │       │              │
  │                                             │       │              │
  └─────────────────────────────────────────────┼───────┼──────────────┘
                                                │       │
                                                ▼       ▼
                                     ┌─────────────────────────┐
                                     │   AWS ElastiCache Redis  │
                                     │                          │
                                     │  rl:ip:login:{ip}        │
                                     │    SortedSet (timestamps)│
                                     │    TTL=61 seconds        │
                                     │                          │
                                     │  rl:acct:login:{hash}    │
                                     │    SortedSet (timestamps)│
                                     │    TTL=901 seconds       │
                                     │                          │
                                     │  login:fail:{email}      │
                                     │    Integer (count)       │
                                     │    TTL=1800 seconds      │
                                     └─────────────────────────┘

  SUCCESS PATH: tokens → response
  FAILURE PATHS:
    ├── WAF: 403 (before even hitting server)
    ├── IP limit: 429 (check Redis, no DB hit)
    ├── Account limit: 423 (check Redis, no DB hit)
    ├── CAPTCHA gate: 400 (verify token, no DB hit)
    └── bcrypt fail: 401 (DB hit, increment counter)

  OBSERVABILITY:
  ┌──────────────────────┐     ┌──────────────────────┐
  │  CloudWatch Metrics  │     │    SNS → Slack/PD    │
  │  login.failures.rate │────►│  Alert: >500 fails/  │
  │  login.lockouts.count│     │  minute = attack     │
  └──────────────────────┘     └──────────────────────┘
```

---

## SECTION 7 — Production Scenarios

### Scenario 1: Credential Stuffing Attack Detected at 3 AM

```
SCENARIO: E-commerce site. Saturday 3:12 AM.
          Suddenly 2,000 failed login attempts per minute.
          Spread across 3,000 different IP addresses.
          All trying different email:password combinations.

DEFENSES IN ACTION:

  WAF rate rule: 100 req/5min per IP.
    → Each of the 3,000 IPs: under 100/5min threshold.
    → WAF rule alone: NOT triggered (distributed attack).

  IP rate limiter (20/min per IP):
    → Each IP: averaging 0.67 requests/min.
    → IP limiter alone: NOT triggered.

  Per-account rate limiter (5 failures/15min per email):
    → alice@company.com: tried from 3 different IPs in 60 seconds.
    → Failure count: 3. CAPTCHA required.
    → Auto bot: cannot solve CAPTCHA. Stops attempting alice@company.com.
    → bob@company.com: tried 5 times from 5 IPs.
    → Failure count hits 5. Account locked. Email unlocked notification sent.

  CloudWatch alarm (>500 failures/minute):
    → ALARM triggered at 3:14 AM.
    → SNS → PagerDuty → on-call engineer wakes up.

  On-call engineer response:
    → Sees: 3,000 IPs, all new, high failure rate, all login endpoint.
    → Action: Enable challenge (CAPTCHA) for ALL login attempts globally (emergency mode).
    → WAF: add IP-reputation rule (block known datacenter/proxy IPs).
    → Result: attack drops 95% within 5 minutes.

LESSON: Per-account limiting caught what IP limiting missed.
        Per-account limiting is essential for distributed attacks.
```

### Scenario 2: Legitimate User Gets Locked Out

```
SCENARIO: User "charlie@company.com" forgets password.
          Tries 6 times in 10 minutes.
          Gets locked out after 5th failure.

EXPERIENCE WITHOUT unlock mechanism:
  User: "I can't login" → support ticket.
  Support: "We'll reset your password" → manual process.
  Time to resolution: 1-2 days.
  User: frustrated, churned.

EXPERIENCE WITH proper unlock flow:
  5th failure: account locked for 30 minutes.
  Email sent immediately: "Someone is attempting to access your account.
    If this was you, click here to unlock: https://app.com/auth/unlock?token=..."

  User: clicks link in 10 seconds. Account unlocked. Resets password.
  Time to resolution: 30 seconds.

  SECURITY PROPERTIES of unlock token:
    - Generated: crypto.randomBytes(32).toString('hex') — unguessable
    - Stored: hash(token) in DB (never store raw token server-side)
    - TTL: 15 minutes (expires automatically)
    - Single use: redeemed? marked used in DB, cannot replay
    - Sent to: verified email only (attacker doesn't have access to inbox)

DESIGN DECISION — automatic time-based unlock vs manual email unlock:
  Automatic (TTL of 30 minutes): simpler, good UX, slight reduction in security
    (attacker can wait 30 minutes and resume attempt).

  Email unlock: better security (requires inbox access, confirms ownership),
    worse UX for user who forgot password (email roundtrip).

  BEST PRACTICE: Both.
    Auto-unlock after 30 minutes PLUS email unlock link for immediate access.

DESIGN DECISION — should lockout hide the existence of the account?
  If you say: "Account locked" → reveals email IS registered.
  If you say: "Invalid credentials" even when locked → attacker doesn't know they found valid email.

  RECOMMENDATION: For high-security apps: always return "INVALID_CREDENTIALS"
    even when locked (no account enumeration).
    Email sent regardless (only reveals lockout to account owner who has inbox access).
```

---

## SECTION 8 — AWS Mapping

### Cognito Rate Limiting (Built-In)

```javascript
// AWS Cognito user pool — built-in rate limiting and lockout
// No custom implementation needed; configure via CloudFormation/CDK

const cognitoConfig = {
  UserPoolId: "us-east-1_...",

  // Policies — rate limiting included automatically:
  Policies: {
    PasswordPolicy: {
      MinimumLength: 12,
      RequireUppercase: true,
      RequireLowercase: true,
      RequireNumbers: true,
      RequireSymbols: true,
      TemporaryPasswordValidityDays: 1,
    },
    // Cognito built-in features (NOT configurable per-pool, managed by AWS):
    //  - Rate limiting: internal AWS rate limits on InitiateAuth
    //  - Lockout: after N failures → PasswordAttemptExceeded exception
    //  - No IP rate limiting built-in: implement at WAF level
  },

  // Advanced security (adaptive authentication) — extra protection:
  UserPoolAddOns: {
    AdvancedSecurityMode: "ENFORCED", // Block: HIGH risk, Audit: MEDIUM, Allow: LOW
    // AWS Cognito Adaptive Auth:
    //   - Analyzes: device fingerprint, location, IP reputation
    //   - On suspicious login: prompts MFA even if not normally required
    //   - Built-in ML model: trained on billions of Cognito logins
  },

  // CloudFormation example for Cognito Advanced Security
};

// COGNITO EXCEPTIONS FOR RATE LIMITING (catch in your auth code):
// NotAuthorizedException         — invalid credentials (catch, increment your own counter)
// UserNotFoundException          — user doesn't exist (treat same as NotAuthorized)
// PasswordResetRequiredException — user must reset
// UserNotConfirmedException      — email not verified
// TooManyRequestsException       — AWS Cognito rate limit hit (429 equivalent)
// PasswordAttemptExceeded        — built-in lockout triggered
```

### WAF Rate-Based Rule (Infrastructure-Level)

```hcl
# terraform/waf.tf — WAF rule for login rate limiting

resource "aws_wafv2_web_acl" "app_waf" {
  name  = "app-web-acl"
  scope = "CLOUDFRONT"

  default_action { allow {} }

  # RULE 1: IP-based rate limit on login endpoint
  rule {
    name     = "LoginEndpointRateLimit"
    priority = 1

    action { block {} }

    statement {
      rate_based_statement {
        limit              = 100          # 100 requests per 5-minute window per IP
        aggregate_key_type = "IP"

        scope_down_statement {
          byte_match_statement {
            field_to_match { uri_path {} }
            positional_constraint = "STARTS_WITH"
            search_string         = "/auth/login"
            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "LoginRateLimit"
      sampled_requests_enabled   = true
    }
  }

  # RULE 2: Block known bad IPs (AWS managed rule group)
  rule {
    name     = "AWSManagedRulesKnownBadInputs"
    priority = 2

    override_action { none {} }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "KnownBadInputs"
      sampled_requests_enabled   = true
    }
  }

  # RULE 3: AWS IP reputation list (known malicious IPs, Tor exit nodes, etc.)
  rule {
    name     = "AWSManagedIPReputationList"
    priority = 3

    action { block {} }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesAmazonIpReputationList"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "IPReputationList"
      sampled_requests_enabled   = false
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "AppWebACL"
    sampled_requests_enabled   = true
  }
}
```

### ElastiCache Redis for Rate Counters

```hcl
# terraform/elasticache.tf — Redis cluster for rate limiting

resource "aws_elasticache_replication_group" "rate_limiter" {
  replication_group_id       = "rate-limiter-redis"
  description                = "Redis cluster for login rate limiting counters"

  node_type                  = "cache.t3.micro"   # ~$15/month, fine for rate limiting
  num_cache_clusters         = 2                   # Primary + 1 replica (HA)
  automatic_failover_enabled = true

  engine_version             = "7.1"
  port                       = 6379

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true          # TLS in transit
  auth_token                 = var.redis_auth_token  # Stored in Secrets Manager

  parameter_group_name       = aws_elasticache_parameter_group.rate_limiter.name
}

resource "aws_elasticache_parameter_group" "rate_limiter" {
  name   = "rate-limiter-params"
  family = "redis7"

  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru"      # Evict LRU keys when full (prevents OOM crash)
  }

  parameter {
    name  = "maxmemory"
    value = "134217728"        # 128MB limit for counter data (more than enough)
  }
}
```

### CloudWatch Alarms + Alert Pipeline

```hcl
# terraform/monitoring.tf

resource "aws_cloudwatch_metric_alarm" "login_failure_spike" {
  alarm_name          = "login-failure-spike-alarm"
  alarm_description   = "Login failure rate spiked — possible credential stuffing"

  namespace           = "Application/Auth"
  metric_name         = "LoginFailures"

  period              = 60          # 1-minute window
  evaluation_periods  = 2           # Alert if 2 consecutive 1-minute windows exceed threshold
  statistic           = "Sum"
  threshold           = 200         # More than 200 failures/minute = alarm
  comparison_operator = "GreaterThanThreshold"

  alarm_actions       = [aws_sns_topic.security_alerts.arn]
  ok_actions          = [aws_sns_topic.security_alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "account_lockouts" {
  alarm_name          = "account-lockout-spike"
  alarm_description   = "Unusual number of account lockouts"

  namespace           = "Application/Auth"
  metric_name         = "AccountLockouts"

  period              = 300         # 5-minute window
  evaluation_periods  = 1
  statistic           = "Sum"
  threshold           = 50          # More than 50 lockouts in 5 minutes = alarm
  comparison_operator = "GreaterThanThreshold"

  alarm_actions       = [aws_sns_topic.security_alerts.arn]
}

# Application-side: emit custom metrics
// In loginHandler — track outcomes:
const cloudwatch = new CloudWatchClient({});

async function emitLoginMetric(outcome) {
  await cloudwatch.send(new PutMetricDataCommand({
    Namespace: 'Application/Auth',
    MetricData: [{
      MetricName: outcome === 'success' ? 'LoginSuccess'
                : outcome === 'failure' ? 'LoginFailures'
                : 'AccountLockouts',
      Value: 1,
      Unit: 'Count',
      Timestamp: new Date(),
    }],
  }));
}
```

### GuardDuty + IAM Role for CloudWatch

```
AWS GUARDDUTY for account takeover signals:
  - UnauthorizedAccess:IAMUser/InstanceCredentialExfiltration — if attacker uses
    compromised account to exfiltrate IAM role credentials
  - UnauthorizedAccess:EC2/SSHBruteForce — SSH brute force on EC2 instances
  - Recon:IAMUser/TorIPCaller — API calls from Tor exit nodes

Integration pattern:
  GuardDuty → EventBridge → Lambda → block IP in WAF + alert security team

AWS COGNITO ADVANCED SECURITY (additional layer):
  When using Cognito for auth:
  - Adaptive auth: risk score per login (new device? new location? known bad IP?)
  - Risk actions: Allow | Require MFA | Block
  - Built-in ML: trained on billions of login events
  - Configuration: UserPoolAddOns.AdvancedSecurityMode = 'ENFORCED'
  - Cost: ~$0.05 per monthly active user (additional to base Cognito pricing)

  // Handle Cognito advanced security challenges:
  // CognitoSignInUserSession may require: SOFTWARE_TOKEN_MFA, SMS_MFA, or be blocked
  // Use AdminRespondToAuthChallenge to handle programmatically
```
