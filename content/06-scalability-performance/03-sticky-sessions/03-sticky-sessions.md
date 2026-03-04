# Sticky Sessions — Part 3 of 3

### Topic: AWS Certification Focus, Comparison Tables, Quick Revision & Architect Exercise

**Series:** Scalability & Performance → Topic 03

---

## SECTION 9 — Certification Focus (AWS SAA)

### AWS ALB Sticky Session Configuration

```
ENABLING STICKY SESSIONS (via Terraform):

resource "aws_lb_target_group" "app" {
  name     = "app-servers"
  port     = 8080
  protocol = "HTTP"
  vpc_id   = var.vpc_id

  health_check {
    path                = "/health"
    healthy_threshold   = 3
    unhealthy_threshold = 5   # Don't be too aggressive removing instances
    timeout             = 5
    interval            = 30
  }

  stickiness {
    type            = "lb_cookie"        # ALB-managed (duration-based)
    cookie_duration = 3600               # 1 hour — match your session TTL
    enabled         = true
  }

  # CRITICAL: connection draining
  deregistration_delay = 60   # 60s to drain in-flight before termination
}

ALTERNATIVE: App-based stickiness (you control the cookie):
  stickiness {
    type        = "app_cookie"
    cookie_name = "myapp_session"   # Your app sets this cookie
    enabled     = true
  }

MONITORING STICKY SESSIONS (CloudWatch metrics to watch):
  TargetGroup: HealthyHostCount — alert if < min viable count
  ALB: HTTPCode_Target_5XX_Count — spike may indicate session state loss
  ALB: TargetResponseTime — check for uneven response times across targets
       (sign that one server has disproportionate sticky session load)

  Custom metric to add:
    Per-instance request rate via ALB access logs → CloudWatch Logs Insights
    Expectation: roughly equal distribution per instance
    Red flag: one instance getting 60%+ of requests while others are at 20%
    (Server imbalance due to sticky session "whale" users)
```

---

### Migration Path: Sticky Sessions → Stateless

```
MIGRATION STRATEGY (zero-downtime transition):

PHASE 1: Add Redis alongside (Week 1)
  Deploy Redis (ElastiCache). No code changes yet.
  Validate Redis is reachable from all app instances.

PHASE 2: Dual-write sessions (Week 1-2)
  On session CREATE: write to both server memory AND Redis.
  On session READ: try Redis first, fall back to memory.
  Deploy this. Both systems live simultaneously.

  Purpose: Warm up Redis with all active sessions.
  Validate that Redis sessions work correctly in production.

PHASE 3: Flip primary read to Redis (Week 2)
  On session READ: ONLY Redis. Memory is dead code now.
  On session CREATE: only Redis. Stop writing to memory.
  Deploy this (no impact — Redis was already being read).

  At this point: sessions are fully in Redis.
  Sticky sessions in ALB technically no longer needed.
  But keep them ON during this phase (safety net).

PHASE 4: Disable sticky sessions, validate (Week 3)
  ALB: disable stickiness.
  Test: log in, perform multi-step operations across page refreshes.
  Verify session continuity across different servers.

  Monitor for 48h: session-related errors, unexpected logouts.
  If clean: done.

PHASE 5: Remove server-memory session code (Week 4)
  Clean up dead code. Tech debt eliminated.

TOTAL MIGRATION: 3-4 weeks. Low risk (rollback at any phase).
Roll back option at each phase: re-enable sticky sessions in ALB.
```

---

## SECTION 10 — Comparison Table

```
┌────────────────────────────┬──────────────────────────────────────────────┐
│ DIMENSION                  │ STICKY SESSIONS                              │
├────────────────────────────┼──────────────────────────────────────────────┤
│ Implementation speed       │ ✅ 2 minutes. Toggle in ALB target group.   │
│                            │ Zero code changes. No new infrastructure.    │
├────────────────────────────┼──────────────────────────────────────────────┤
│ Enables stateful servers   │ ✅ Multi-step wizard, in-memory computations,│
│ to work briefly            │ WebSocket upgrade handshakes — all work with │
│                            │ sticky sessions routing correctly.           │
├────────────────────────────┼──────────────────────────────────────────────┤
│ Load distribution          │ ❌ Pins users to servers. If some users are │
│                            │ "heavy," one server is overloaded.          │
│                            │ Load balancer doesn't truly balance anymore. │
├────────────────────────────┼──────────────────────────────────────────────┤
│ Failover                   │ ❌ Server dies → all its pinned users lose   │
│                            │ sessions. User-visible data loss.            │
├────────────────────────────┼──────────────────────────────────────────────┤
│ Auto-scaling               │ ❌ Scale-in terminates pinned instances.     │
│                            │ Teams either disable scale-in or accept      │
│                            │ periodic user logouts.                       │
├────────────────────────────┼──────────────────────────────────────────────┤
│ Deployments                │ ❌ Rolling deploy restarts servers.          │
│                            │ Users on restarted server lose sessions.     │
│                            │ Forces off-hours maintenance windows.        │
├────────────────────────────┼──────────────────────────────────────────────┤
│ Multi-region               │ ❌ AWSALB cookie is region-specific.        │
│                            │ Multi-region active-active: not possible     │
│                            │ with sticky sessions.                        │
└────────────────────────────┴──────────────────────────────────────────────┘
```

---

## SECTION 11 — Quick Revision

**Q: "What are sticky sessions and what problem do they solve?"**

> "Sticky sessions are a load balancer feature that routes a given user's requests consistently to the same backend instance. They solve the problem of stateful servers — where session data (user state, cart, etc.) lives in a specific server's memory. Without sticky sessions, a round-robin router might send the second request to a different server that has no knowledge of the session created by the first request.
>
> The important context is that sticky sessions are a workaround, not a solution. They trade load distribution correctness and failover for session continuity. The actual solution is stateless servers: move session state out of server memory and into a shared external store like Redis. Then any server can serve any request and sticky sessions are unnecessary."

---

**Q: "If you're running 5 servers with sticky sessions and one crashes, what happens?"**

> "All users whose sessions were pinned to the crashed server lose their sessions — they're effectively logged out the next time they make a request. The load balancer detects the failed health check, removes the server from rotation, and re-routes those users' subsequent requests to other servers. But those servers have no knowledge of the sessions that were in the failed server's memory. The session state is gone.
>
> This is the core failover problem with sticky sessions. Each pinned server is a single point of failure for its set of users. Contrast with Redis-backed sessions: if a server crashes, ALL of its users' sessions survive because the state was in Redis, not in the server's RAM. The users transparently continue on other servers."

---

## SECTION 12 — Architect Thinking Exercise

**Scenario:** A video conferencing app uses sticky sessions. Users join meeting rooms. The app stores active room state (participants, media streams, chat) in the server's process memory. A traffic spike causes an auto-scale event. Design the transition to stateless while keeping rooms working.

---

**Answer:**

```
PROBLEM ANALYSIS:
  Sticky sessions here aren't just for user auth — they're for SHARED ROOM STATE.
  Room "meet_abc": participants Alice, Bob, Charlie — all connected to Server 2.
  If Server 2 dies: the room itself is lost, not just auth sessions.
  This is deeper statefulness than just user auth.

PHASE 1 — EXTRACT ROOM STATE TO REDIS (Non-Negotiable First Step):

  Redis data model:
    room:{roomId}:state → { roomId, host, startedAt, settings }  (Hash)
    room:{roomId}:participants → Set of { userId, displayName, audioEnabled, videoEnabled }
    room:{roomId}:chat → List of { userId, message, timestamp } (capped at 500)

  Each participant's media connection info: stored in Redis on join.
  Each server: coordinates room state via Redis, not local memory.

PHASE 2 — WEBSOCKET COORDINATION VIA REDIS PUB/SUB:

  Challenge: participants in the SAME room may be on DIFFERENT servers
  after going stateless (different ALB routing paths).

  Solution: Redis Pub/Sub channel per room

  Server 2 has Alice. Server 3 has Bob (same room).
  Alice mutes: Server 2 publishes to channel "room:meet_abc:events":
    { event: "mute", userId: "usr_alice" }

  Server 3 subscribes to "room:meet_abc:events".
  Server 3 receives the mute event → pushes to Bob's WebSocket → Bob sees Alice muted.

  Cross-server room event delivery: via Redis pub/sub (< 1ms within AZ).

PHASE 3 — ACTUAL MEDIA (WebRTC — different concern):
  WebRTC is peer-to-peer (browser ↔ browser).
  The server only handles signaling (offer/answer/ICE exchange).
  Signaling can go through ANY server — no stickiness needed.
  Media streams: direct between clients (no server RAM involved).

RESULT AFTER MIGRATION:
  Any server can handle any participant in any room.
  Server crashes: participants' WebSocket connections drop briefly (< 5s reconnect).
  On reconnect: any server looks up Redis → room state intact, rejoin seamlessly.
  Auto-scaling: no session loss during scale-in. Drain connections (30s), terminate.
```

---

## === Architect's Mental Model ===

### 5 Decision Rules

**Rule 1: Sticky sessions are a bridge, not a destination.**
When you enable them, write a ticket with a deadline to migrate to stateless sessions. The ticket should go into the current sprint backlog. If you don't do this, sticky sessions become a permanent fixture and accumulate the dependencies (disabled auto-scaling, forced maintenance windows, multi-region impossibility) that will cost orders of magnitude more to fix later.

**Rule 2: Sticky sessions do NOT solve the failover problem — they just hide it temporarily.**
"Sticky sessions keep my users' sessions alive" is only true while the server stays alive. Server failure = session loss. This is not highly available. True HA for user sessions requires external session storage. Don't let "sticky sessions are working" create false confidence about your system's availability.

**Rule 3: Watch for load imbalance metrics when sticky sessions are in use.**
Add a CloudWatch dashboard: per-instance request rate. If one instance is handling 3× the requests of others, you have sticky session "whales" — a few heavy users pinned to a single server. This is invisible without monitoring. Left undetected: one instance runs hot, degrades, flaps health checks, gets removed, redistributing hundreds of sticky sessions at once — the cascade you were trying to avoid.

**Rule 4: Set the cookie duration to match the session TTL — not longer.**
If sessions expire after 2 hours and the sticky cookie lasts 24 hours: for 22 hours after a session expires, requests are still being pinned to the same server for no reason. The instance might have been replaced. The cookie now points to a dead target. Match them: stickiness TTL = session TTL. Review this in the ALB configuration explicitly; the defaults are often 1 day regardless of your session design.

**Rule 5: Never use sticky sessions in a multi-region architecture.**
The AWSALB cookie encodes a target in a specific AWS region-specific target group. A user whose request fails over to another region has an AWSALB cookie that means nothing there. Multi-region active-active (Route 53 latency routing) with sticky sessions: requests fail silently until the AWSALB cookie expires and a new one is issued. Stateless sessions (Redis with cross-region replication) is the only viable multi-region session strategy.

---

### 3 Common Mistakes

**Mistake 1: Disabling auto-scaling scale-in to "protect" sticky sessions.**
The natural reaction when sticky session scale-in causes logouts: "Let's never scale in." The ASG minimum is now set equal to maximum. You're paying peak-traffic costs 24/7. On a monthly bill, this is often the most expensive consequence of sticky sessions. Calculate the cost: (max_instances - avg_instances) × instance_cost × hours/month. Frequently $10,000–$50,000/month wasted. The Redis migration is cheap by comparison.

**Mistake 2: Enabling sticky sessions for an API that claims to be stateless.**
"Our API is REST — it's stateless." But the team added a feature that caches computation results in a local Map for the duration of a user "session." Now there's hidden local state. Sticky sessions are turned on "just in case." Now future engineers see sticky sessions and think they're required for correctness — but don't know why. The original reason is forgotten. Years later, nobody removes them. Audit: document WHY sticky sessions are on. If you can't explain it: they probably shouldn't be.

**Mistake 3: Not setting connection draining (deregistration delay) correctly.**
Default: 300 seconds in AWS. During scale-in: the instance waits 300 seconds before terminating. 4 instances scaling in × 300s drain = up to 20 minutes of limbo. Auto-scaling barely works at that pace. But setting it to 0: in-flight requests are dropped mid-processing — users see 500 errors. Right value: match to P99 request duration + buffer. If 99% of requests finish in 5 seconds: set drain to 30 seconds. Not 300. Not 0.

---

### 30-Second Interview Answer

> "Sticky sessions pin a user's requests to the same backend server using a cookie set by the load balancer. They solve the problem of server-local session state — without them, stateful servers cause users to be effectively logged out on every random server rotation. The tradeoff is severe: sticky sessions break load distribution (heavy users overload their pinned server), break auto-scaling (scale-in terminates pinned instances and loses sessions), break deployments (rolling restarts log users out), and are incompatible with multi-region. The correct architectural answer is stateless servers with Redis-backed sessions where any server can handle any request. Sticky sessions are only acceptable as a temporary workaround during a migration to stateless, with an explicit deadline to remove them."

---

_End of Topic 03 — Sticky Sessions_
