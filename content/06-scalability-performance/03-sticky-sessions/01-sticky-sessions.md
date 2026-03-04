# Sticky Sessions — Part 1 of 3

### Topic: Foundations — Intuition, Core Concepts, Architecture & Data Flow

**Series:** Scalability & Performance → Topic 03

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

### The Assigned Bank Teller

```
BANK WITHOUT STICKY SESSIONS:
  You walk in to complete a mortgage application (multi-step process).
  Teller A helps you with Step 1. Takes your documents. Starts a file.
  You come back 10 minutes later.
  Teller B answers: "Documents? What documents? I don't have any file for you."

  Teller A has YOUR FILE on their desk (server-local state).
  You MUST go back to Teller A, or you start over.

BANK WITH STICKY SESSIONS:
  Reception assigns you to Teller A.
  Every time you visit during this application: you go to Teller A.
  Teller A has your file. Continuity maintained.

  "Token issued: 'This customer is assigned to Teller A.'"
  Every new visit: receptionist checks token → routes to Teller A.

  THIS IS STICKY SESSIONS:
    The load balancer checks the session cookie.
    Sees: "User is assigned to Server 2."
    Routes this user's request to Server 2. Always.

  THE PROBLEMS WITH THE BANK ANALOGY:
  What if Teller A is sick today? (Server 2 crashes)
    → Your file is on Teller A's desk. Nobody else has it.
    → You lose your progress. Start over.

  What if Teller A is very popular? (Server 2 has many assigned users)
    → Teller A is overloaded with 200 customers.
    → Teller B and C are standing idle with 20 customers each.
    → The "load balancer" is no longer balancing load.
```

---

### The Grocery Store Checkout Lane

```
IMAGINE: You load a full cart onto the conveyor belt of Lane 3.
Halfway through scanning, the cashier says:
"Sorry, you have to move to Lane 5."

You pick everything up. Move to Lane 5.
Lane 5: "What items? You haven't scanned anything."

YOUR CART STATE IS GONE and you're starting over.
This is the stateful server problem that sticky sessions solve.

STICKY SESSIONS = "You stay in Lane 3 until your transaction is done."

PROBLEM: Lane 3's cashier takes a break. Lane 3 closes.
All the people in Lane 3's queue (your session-mates) lose their
in-progress scans. They're redistributed — but the in-progress
cart data was at Lane 3. Gone.

WHAT WOULD ACTUALLY SOLVE IT:
A central system that tracks everyone's cart that ANY cashier can access.
Then it doesn't matter which lane you're in.
(This is the external session store — the correct solution.)

STICKY SESSIONS IS A WORKAROUND.
STATELESS ARCHITECTURE IS THE FIX.
Sticky sessions exist when teams can't immediately refactor to stateless
— it buys time at the cost of load distribution and failover.
```

---

## SECTION 2 — Core Technical Explanation

### The Immediate Problem Sticky Sessions Addresses

```
CONTEXT: You've added a second app server to handle increased load.
Nothing else changed. Sessions are still in server local memory.

WITHOUT STICKY SESSIONS (broken):

  Alice logs in. ALB → Server 1.
  Server 1 creates: memory["sess_alice"] = { userId: 1, cart: [...] }

  Alice adds to cart. ALB → Server 2 (round robin).
  Server 2 has no sess_alice → "Not authenticated." HTTP 401.
  Alice is logged out. Cart is lost.

WITH STICKY SESSIONS (workaround):

  Alice logs in. ALB → Server 1.
  ALB sets cookie: AWSALB=<encoded-target-server>  (auto by AWS ALB)

  Alice adds to cart. ALB → reads AWSALB cookie → "This is Server 1."
  → Routes to Server 1 regardless of current load.
  Server 1 has sess_alice → ✅ Request succeeds.

  Alice's entire session: always Server 1.
  Bob's entire session: always Server 2 (wherever he first landed).

  The session data stays co-located with the user's routing pin.

WHEN IS THIS THE RIGHT DECISION:
  ✅ Legacy app that can't be refactored to stateless in the short term
  ✅ Temporary workaround during a migration to stateless architecture
  ✅ Short-lived sessions where the risk of server failure during the session is low
  ✅ Development/staging environment where availability SLA is not critical

WHEN THIS IS THE WRONG DECISION:
  ❌ You plan to auto-scale frequently (sticky sessions fight auto-scaling)
  ❌ You need high availability (server failure = user session loss)
  ❌ You're building a new system (no reason to start with sticky sessions)
  ❌ Sessions are long-lived (risk of pinned server failing increases with time)
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

### How AWS ALB Implements Sticky Sessions

```
ALB STICKINESS MECHANISM:

  Type 1: Duration-based (ALB-managed)
    ALB automatically generates and manages the stickiness cookie.
    Cookie name: AWSALB
    Cookie value: encoded routing rule (not human-readable)
    TTL: Configurable (1 second to 7 days)

    How it works:
    ① User's first request: no AWSALB cookie.
       ALB picks a target using normal routing algorithm.
       Response includes: Set-Cookie: AWSALB=<token>; Path=/; Max-Age=86400

    ② User's subsequent requests: Cookie: AWSALB=<token>
       ALB decodes the token → "Route to target instance ID i-0abc123"
       Request goes to that specific instance.

    ③ Instance fails: ALB detects health check failure.
       Instance removed from target group.
       AWSALB cookie now points to a dead instance.
       ALB can't route to it → picks a NEW instance.
       Sets new AWSALB cookie pointing to the new instance.
       ⚠ Session data from the failed instance is LOST.
          New instance has no sess_alice.
          User is logged out.

  Type 2: Application-based (app-managed)
    YOUR app sets the stickiness cookie:
    Set-Cookie: myapp_session_pin=server2; Path=/; HttpOnly; Max-Age=3600

    ALB is configured: "Use cookie named 'myapp_session_pin' for routing."
    App has full control over TTL and content.
    Useful when you want the app to explicitly control which server a user pins to.

DURATION RECOMMENDATION:
  Match to your session TTL.
  If user sessions expire after 2 hours: set stickiness TTL to 2 hours.
  Longer stickiness than session = waste (user session expired but still pinned).
  Shorter stickiness = user repinned to new server mid-session → session loss.
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

### Sticky Session Routing Flow

```
WITHOUT STICKY SESSIONS (broken with stateful servers):

  Alice Request #1 → ALB → Server 1 (creates session in Server 1 RAM)
  Alice Request #2 → ALB → Server 2 (round robin — no session here → 401!)

──────────────────────────────────────────────────────────────────────────────

WITH STICKY SESSIONS (workaround):

  CLIENT (Alice)
      │  Request #1: GET /login  (no AWSALB cookie)
      ▼
  ┌─────────────────────────────────────┐
  │   ALB                               │
  │   No AWSALB cookie → pick Server 1  │
  │   (normal routing, round robin)     │
  └──────────────────┬──────────────────┘
                     │
                     ▼ Server 1
              ┌──────────────┐
              │   Server 1   │  Creates: sessions["alice"] = { ... }
              │   RAM:       │  Responds: HTTP 200
              │   [sess_alice│  Set-Cookie: AWSALB=<token_pointing_to_S1>
              └──────────────┘

  CLIENT receives: AWSALB cookie (stores it)

  ─────────────────────────────────────────────────────────────────────────

  CLIENT (Alice)
      │  Request #2: POST /cart/add  Cookie: AWSALB=<token_pointing_to_S1>
      ▼
  ┌─────────────────────────────────────┐
  │   ALB                               │
  │   AWSALB found → decode → Server 1  │ ← STICKY! Bypasses round robin.
  │   Route to Server 1 regardless      │
  │   of Server 1's current load        │
  └──────────────────┬──────────────────┘
                     │  ALWAYS Server 1 for Alice
                     ▼
              ┌──────────────┐
              │   Server 1   │  Finds sessions["alice"] → ✅
              │   RAM:       │
              │   [sess_alice│
              └──────────────┘

  ┌──────────────┐   ← Server 2 is IDLE or handling other users.
  │   Server 2   │      Load is NOT balanced if many users are pinned to S1.
  └──────────────┘

──────────────────────────────────────────────────────────────────────────────

FAILURE SCENARIO (why sticky sessions are fragile):

  Server 1 crashes at 2PM (hardware failure).

  ALB health check: Server 1 fails 3 consecutive checks → marks UNHEALTHY.
  Alice sends Request #3: Cookie: AWSALB=<token_pointing_to_S1>

  ALB: "Server 1 is unhealthy. Can't route there."
  ALB picks Server 2 (only healthy instance).
  ALB issues NEW cookie: AWSALB=<token_pointing_to_S2>

  Server 2: no sessions["alice"]. Alice is logged out.
  Cart lost. Whatever she was doing: gone.

  This is the fundamental fragility: sticky sessions create per-user SPOFs.
```

---

### Sticky Sessions vs Stateless: Comparison Diagram

```
┌─────────────────────────────────┐  ┌─────────────────────────────────┐
│     STICKY SESSIONS             │  │     STATELESS + REDIS           │
├─────────────────────────────────┤  ├─────────────────────────────────┤
│ Client → ALB → (pinned) Srv 1   │  │ Client → ALB → ANY Server       │
│                                 │  │                │                 │
│ Srv 1 dies:                     │  │ Any Server → Redis               │
│   Alice loses session ❌        │  │ Srv 1 dies:                      │
│                                 │  │   Alice continues on Srv 2 ✅    │
├─────────────────────────────────┤  ├─────────────────────────────────┤
│ Load distribution:              │  │ Load distribution:               │
│   Srv 1: 400 users (heavy ones) │  │   Each server: equal share ✅   │
│   Srv 2: 50 users ❌            │  │                                 │
├─────────────────────────────────┤  ├─────────────────────────────────┤
│ Auto-scaling:                   │  │ Auto-scaling:                    │
│   New server joins: gets 0      │  │   New server joins: immediately  │
│   sticky users. Underutilized.  │  │   gets its share of requests. ✅│
│   Scale-in: pins to dead        │  │   Scale-in: no session impact. ✅│
│   server → session loss ❌      │  │                                 │
├─────────────────────────────────┤  ├─────────────────────────────────┤
│ Deploy:                         │  │ Deploy:                          │
│   Rolling: users on restarting  │  │   Rolling: zero session loss. ✅ │
│   server lose session ❌        │  │                                 │
├─────────────────────────────────┤  ├─────────────────────────────────┤
│ Complexity: LOW                 │  │ Complexity: MEDIUM               │
│ (config in ALB, no code change) │  │ (requires Redis setup)          │
└─────────────────────────────────┘  └─────────────────────────────────┘
```

---

_→ Continued in: [02-Sticky Sessions.md](02-Sticky%20Sessions.md)_
