# Sticky Sessions — Part 2 of 3

### Topic: Real World Examples, System Design Importance, AWS Mapping & Interview Prep

**Series:** Scalability & Performance → Topic 03

---

## SECTION 5 — Real World Example

### Full Annotated: Multi-Step Process with Sticky Sessions

```
SCENARIO: 3-step user onboarding wizard.
Session state: wizard progress stored in server RAM.
2 app servers. Sticky sessions enabled (ALB duration-based, 30min TTL).

────────────────────────────────────────────────────────────────────────────
STEP 1: POST /onboarding/step1  (No AWSALB cookie — first visit)
────────────────────────────────────────────────────────────────────────────

ALB receives request:
  No AWSALB cookie → apply normal routing algorithm (least connections).
  Server 2 has fewer connections currently → route to Server 2.

Server 2:
  Creates wizard state:
    sessions["wizard_bob"] = { step: 1, name: "Bob", email: "bob@example.com" }
  Returns: HTTP 200 { nextStep: "/onboarding/step2" }

ALB intercepts response:
  Injects: Set-Cookie: AWSALB=<hash_to_server_2>; Max-Age=1800

Browser stores AWSALB cookie.

────────────────────────────────────────────────────────────────────────────
STEP 2: POST /onboarding/step2  (Cookie: AWSALB=<hash_to_server_2>)
────────────────────────────────────────────────────────────────────────────

ALB receives request:
  AWSALB cookie present → decode → "Route to Server 2"
  Server 1 is actually less loaded. DOESN'T MATTER. Pinned to Server 2.
  Routes to Server 2.

Server 2:
  Finds sessions["wizard_bob"] = { step: 1, name: "Bob", email: "bob@example.com" }
  Updates: sessions["wizard_bob"].step = 2
           sessions["wizard_bob"].company = "Acme Corp"
  Returns: HTTP 200 { nextStep: "/onboarding/step3" }

────────────────────────────────────────────────────────────────────────────
STEP 3: POST /onboarding/step3  (15 minutes later. AWSALB still valid: 30min TTL)
────────────────────────────────────────────────────────────────────────────

ALB: AWSALB → Server 2.

FAILURE SCENARIO:
  Between Step 2 and Step 3, Server 2 was replaced (auto-scaling, instance refresh).

  ALB health check detects new target. ⚠
  AWSALB cookie still points to old Server 2 instance ID.
  Old instance is gone.

  ALB behavior: can't find the instance the cookie references.
  Routes to Server 1 (as fallback).

  Server 1: no sessions["wizard_bob"].
  Returns: HTTP 401 or sends user back to Step 1.
  Bob loses all his onboarding progress mid-wizard.
  Support ticket: "Your wizard deleted my data."
```

---

### Sticky Session Cookie Details

```
AWS ALB COOKIE INSPECTION:

Request headers (what ALB reads):
  Cookie: AWSALB=H4sIAAAA/2rN...; session=auth_token_here

AWSALB cookie contents (opaque to your app):
  Encoded target group + instance routing information.
  NOT human-readable. NOT manipulable by clients.
  Signed server-side to prevent forgery.

When ALB issues a new sticky cookie:
  Response headers:
    Set-Cookie: AWSALB=<new_token>; Path=/; Max-Age=86400; HttpOnly
    Set-Cookie: AWSALBCORS=<new_token>; Path=/; Max-Age=86400; SameSite=None; Secure
    (ALB issues both AWSALB and AWSALBCORS for CORS scenarios)

IMPORTANT: Stickiness granularity
  Stickiness is per TARGET GROUP.
  If you have multiple target groups behind one ALB (path-based routing):
    /api/* → Target Group A (API servers, stickiness enabled)
    /admin/* → Target Group B (admin servers, stickiness disabled)

  Stickiness settings are per target group, not per listener.
```

---

## SECTION 6 — System Design Importance

### The Uneven Load Distribution Problem

```
PRODUCTION SCENARIO: Black Friday traffic spike.

9AM: 4 servers, 1,000 active users, stickiness enabled.
  Server 1: 250 users pinned (mix of browsing + checkout)
  Server 2: 250 users pinned
  Server 3: 250 users pinned
  Server 4: 250 users pinned

9:01AM: Email campaign fires. 2,000 new users arrive.
  Auto-scaling triggers: 4 new servers (Servers 5-8) launch.
  They're healthy. ALB adds them to the target group.

  But: new users only.
    Server 5: 500 new users (healthy, gets new users)
    Server 6: 498 new users
    Server 7: 502 new users
    Server 8: 500 new users

  OLD servers: still pinned by existing users.
    Server 1: 250 original + 0 new = 250 (CPU 20%)
    Server 2: 250 original + 0 new = 250 (CPU 20%)
    (new servers get all new traffic — old servers stay at old baseline)

  Wait — this is actually OK! Old servers aren't overloaded.

  BUT: consider the "whale" problem:

  Some users on Server 1 are running long compute jobs (report generation).
  Server 1 CPU: 90%. All new users ALB wants to send — it routes away from Server 1.
  But THE EXISTING 250 PINNED USERS ON SERVER 1: they're stuck there.

  The ALB can't redistribute existing sticky sessions.
  If Server 1 is overloaded with its existing users:
  Those users STAY on Server 1. They see slow responses.
  New users on Server 5: fast responses.
  SAME APP. SAME TIME. DIFFERENT EXPERIENCE. Sticky sessions causing service inequality.
```

---

### The Scale-In Session Loss

```
SCENARIO: Traffic spike subsides. Auto-scaling scales IN.
ASG selects Server 6 for termination (lowest recent activity).

Without connection draining:
  Server 6 receives termination signal.
  ALB immediately stops sending new requests to Server 6. ✅
  But: Server 6 is gone. AWSALB cookies pointing to Server 6 are orphaned.

  300 users with AWSALB=<server_6_hash>:
    Their next request: ALB can't find Server 6. Re-routes to another server.
    New server: no session for them. They're effectively logged out.
    Loss: 300 active user sessions.

WITH CONNECTION DRAINING (mitigated but not eliminated):
  ALB marks Server 6 as "draining" — stops sending NEW requests there.
  Existing in-flight requests: given 60 seconds to complete.
  Server 6 sessions: STILL LOST after 60s (session data in RAM, destroyed on terminate).

  Users who don't make a request in that 60-second window:
    Their session data is gone when they DO make a request.
    The drain period only helps in-flight requests — not idle sessions.

NO MITIGATION AT ALL:
  Sticky sessions under auto-scaling = periodic involuntary logouts during scale-in.
  This is why teams with sticky sessions:
  ① Disable scale-in entirely (run at peak capacity all day → waste $$)
  ② Set very long cool-down periods (no scale-in for hours after scale-out)
  Both are compromises. Neither is correct.
```

---

## SECTION 7 — AWS & Cloud Mapping

### When Sticky Sessions Trap Engineering Teams

```
THE STICKY SESSION DEBT SPIRAL:

Year 1: "Quick fix: enable sticky sessions in ALB. Ship it."
        Two app servers now work. Users aren't logged out. ✅

Year 2: "Auto-scaling keeps logging users out after scale-in. Disable scale-in."
        ASG: min=max=desired capacity (no auto-scaling). $$$$/month wasted.

Year 3: "Deployments log users out. Do deploys at 3AM only."
        Deploy frequency: once per week. Feature velocity drops.

Year 4: "We need to go multi-region. How do sessions work across regions?"
        Stuck. AWSALB cookie is region-specific. Can't cross regions.
        Performance in other regions: impossible without major refactor.

Year 5: "We need to migrate to stateless sessions."
        5 years of technical debt. Large migration project.
        Risk: two session systems in parallel during migration.
        Duration: 3-6 months. Engineering focus diverted.

THE CORRECT LESSON:
  Use sticky sessions only as a TEMPORARY MEASURE during a migration.
  Set a hard deadline for deprecation when you enable it.
  "We will refactor to Redis sessions within 2 sprints."
  Don't let it become permanent.
```

---

## SECTION 8 — Interview Preparation

**Beginner:**

**Q: What are sticky sessions?**
**A:** Sticky sessions mean the load balancer always sends the same user to the same server â€” like being assigned your own personal checkout lane at a supermarket. Once you start your transaction with Lane 3 (Server 3), you always go back to Lane 3 until your transaction is complete. This is needed when the server stores your session data in its own memory.

**Q: What problem do sticky sessions solve?**
**A:** If your session data is stored in Server A's memory, and the load balancer routes your next request to Server B, Server B says "Who are you? I don't know you." You'd be logged out or lose your shopping cart. Sticky sessions prevent this by ensuring you always talk to the same server.

**Q: What's the main downside of sticky sessions?**
**A:** Uneven load distribution. If 80% of your users get assigned to Server 1 and 20% to Server 2, Server 1 becomes a bottleneck. Also, if the sticky server crashes, users lose their session anyway. Sticky sessions are a workaround, not a real solution â€” the real fix is making your app stateless.

---

**Intermediate:**

**Q: How does ALB implement sticky sessions in AWS, and what are the two types?**
**A:** ALB offers (1) *Duration-based stickiness* â€” ALB sets a cookie (AWSALB) with a configurable TTL (1 second to 7 days). All requests carrying this cookie go to the same target. (2) *Application-based stickiness* â€” your app sets a custom cookie and ALB honours it. Duration-based is simpler; application-based lets you control the cookie name/value for custom routing logic.

**Q: When is sticky sessions the right architectural choice vs. when should you avoid it?**
**A:** Use sticky sessions *only* as a short-term fix for legacy stateful apps that can't be changed, or for WebSocket connections where persistent routing is required. Avoid it for REST APIs â€” it creates uneven load distribution and causes problems during deployments (draining sticky connections takes time). Better long-term: externalize session state to Redis so any server can handle any request.

**Q: How do sticky sessions interact with auto-scaling during scale-in events?**
**A:** When an instance is removed from the ASG, its sticky connections must be "drained" â€” ALB stops routing new sessions to it but keeps existing sessions alive until they expire or disconnect. ALB's deregistration delay (default 300 seconds) handles this. If a deployment or crash removes the server before sessions expire, those users lose their sessions regardless. This is why sticky sessions don't truly solve the session affinity problem.

---

**Advanced (System Design):**

**Scenario 1:** You have a real-time collaborative editing tool (like Google Docs) running on 5 servers with sticky sessions. 40% of your users are stuck on Server 1. Server 1 is at 90% CPU. You can't easily move sessions. How do you solve this without downtime?

*Immediate:* Vertically scale Server 1 (more CPU). Also check: is the uneven distribution caused by session-based vs. IP-based stickiness? IP-based stickiness groups all users behind a corporate NAT onto one server â€” switch to cookie-based to distribute better.
*Proper fix:* Migrate real-time state to a dedicated service (Socket.io with Redis adapter, or AWS API Gateway WebSocket). Once the real-time layer is shared via Redis pub/sub, app servers become stateless and sticky sessions are no longer needed.

**Scenario 2:** Design an online multiplayer game lobby system serving 100,000 concurrent users where players in the same game room must always communicate through the same server for low latency â€” but the architecture must survive any single server failure without losing in-progress games.

*Architecture:* Game state stored in Redis (not in-process). WebSocket connections use sticky sessions to the same app server. On server failure: ALB detects health check failure â†’ routes new connections to healthy servers. Reconnecting clients check Redis for game state and rejoin. Game rooms are Redis-backed, so any server can load the state. Server failure = brief reconnection (2-5s), not data loss.

