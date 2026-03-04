# Graceful Shutdown

## FILE 01 OF 03 — Core Concepts, SIGTERM Handling & ECS Integration

> **Architect Training Mode** | Site Reliability Engineer Perspective
> _A service that doesn't know how to stop correctly loses in-flight requests, corrupts data, and leaves users confused. Stopping cleanly is as important as starting correctly._

---

## SECTION 1 — Intuition (Explain Like a 12-Year-Old)

```
WITHOUT GRACEFUL SHUTDOWN:
  ECS decides to stop a task (deploy, scale-in, task replacement).
  ECS sends SIGTERM to container process.
  Node.js default: process exits immediately (or in 10 seconds with SIGKILL).

  At that exact moment:
    Request 1: user submitting payment → halfway through DB transaction → ABORTED.
    Request 2: sending email via SES → SDK call in flight → connection dropped.
    Request 3: writing to S3 → incomplete upload → corrupted file.
    Queued job: background worker processing order → stopped mid-way → order stuck as "processing".

  User experience:
    "I was charged but my order shows as failed."
    "I never got my confirmation email."
    "The uploaded file is corrupted."

WITH GRACEFUL SHUTDOWN:
  ECS sends SIGTERM.
  Server: "I hear you. Stopping gracefully."
  Step 1: Stop accepting NEW requests (close HTTP listener).
  Step 2: Let in-flight requests complete (wait up to 30 seconds).
  Step 3: Close DB connections cleanly.
  Step 4: Flush log buffers.
  Step 5: process.exit(0).

  During steps 1-4: every in-flight request finishes normally.
  User who submitted payment: transaction completes. Charged correctly. Order created.
  Zero data corruption. Zero incomplete operations.
```

---

## SECTION 2 — Core Technical Explanation

```
ECS FARGATE SHUTDOWN SEQUENCE:

  1. ECS sends SIGTERM to the container's PID 1.
     This is the signal: "please stop soon, we're replacing/scaling/restarting you."

  2. Wait: ECS waits up to stopTimeout seconds (default: 30s).
     During this window: your app should handle in-flight requests and clean up.

  3. If app hasn't exited by stopTimeout: ECS sends SIGKILL.
     SIGKILL = immediate, forced kill. Cannot be caught. Process terminates instantly.
     This is the deadline. Your cleanup MUST complete before SIGKILL.

  TIMELINE:
    t=0   → SIGTERM received
    t=0   → App: stop accepting new connections
    t=0   → ALB: should already have removed the task (via health check or deregistration)
    t=0–X → In-flight requests complete (X = up to your gracefulShutdownTimeout)
    t=X   → DB connections closed, buffers flushed, process.exit(0)
    t=30  → SIGKILL if app hasn't exited (ECS stopTimeout)

  KEY RULE: your graceful shutdown timeout MUST be < ECS stopTimeout.
    If requests need up to 25 seconds to complete: set graceful shutdown to 25s.
    Set ECS stopTimeout to 35s (5-10 second buffer before SIGKILL).

CONFIGURING ECS stopTimeout:
  {
    "containerDefinitions": [{
      "name": "api",
      "image": "...",
      "stopTimeout": 35      // seconds before SIGKILL (must be > your graceful timeout)
    }]
  }

  Terraform:
    resource "aws_ecs_task_definition" "api" {
      # ...
      container_definitions = jsonencode([{
        name         = "api"
        image        = "..."
        stopTimeout  = 35
        # ...
      }])
    }
```

---

## SECTION 3 — Architecture Diagram (MANDATORY)

```typescript
// server.ts — complete graceful shutdown implementation

import express from "express";
import { Server } from "http";
import { pool } from "./db"; // pg-pool
import { logger } from "./logger"; // pino logger

const app = express();
// ... routes ...

async function shutdown(signal: string, server: Server): Promise<void> {
  logger.info({ event: "shutdown_initiated", signal });

  // Step 1: Stop accepting new connections.
  // Existing connections are kept alive until their requests finish.
  server.close(async (err) => {
    if (err) {
      logger.error({
        event: "shutdown_server_close_error",
        error: err.message,
      });
    } else {
      logger.info({ event: "shutdown_server_closed" });
    }

    // Step 2: Close database connection pool.
    // pg-pool.end() waits for all active queries to complete, then closes connections.
    try {
      await pool.end();
      logger.info({ event: "shutdown_db_pool_closed" });
    } catch (dbErr: any) {
      logger.error({ event: "shutdown_db_pool_error", error: dbErr.message });
    }

    // Step 3: Flush any buffered logs (pino uses async writes).
    logger.flush();

    // Step 4: Exit cleanly.
    logger.info({ event: "shutdown_complete" });
    process.exit(0);
  });

  // Safety net: if server.close() callback never fires within our window,
  // force exit before ECS sends SIGKILL.
  setTimeout(() => {
    logger.warn({ event: "shutdown_timeout_forced_exit" });
    process.exit(1); // exit code 1 = abnormal termination
  }, 25_000); // 25s < 35s ECS stopTimeout
}

// Start the server:
const server = app.listen(8080, () => {
  logger.info({ event: "server_listening", port: 8080 });
});

// Register signal handlers:
process.on("SIGTERM", () => shutdown("SIGTERM", server));
process.on("SIGINT", () => shutdown("SIGINT", server)); // Ctrl+C in development

// Handle unhandled errors — don't let them silently corrupt state:
process.on("uncaughtException", (err) => {
  logger.error({
    event: "uncaught_exception",
    error: err.message,
    stack: err.stack,
  });
  shutdown("uncaughtException", server);
});

process.on("unhandledRejection", (reason) => {
  logger.error({ event: "unhandled_rejection", reason: String(reason) });
  // Don't exit on every unhandled promise — log and monitor instead.
  // Some teams prefer to exit here for stricter behavior.
});
```

---

## SECTION 4 — Request Flow (MANDATORY FLOWCHART)

```
WHAT IS CONNECTION DRAINING?
  When ECS stops a task, it must also tell the ALB to stop sending new requests to it.
  This is handled by the ALB deregistration_delay.

  SEQUENCE WITH ALB:
    t=0   → ECS decides to stop task
    t=0   → ECS puts task in DEREGISTERING state with ALB target group
    t=0–30 → ALB "drains" the task:
              New requests: not routed to this task (sent to other healthy tasks)
              Existing in-flight requests: allowed to complete (on this task)
    t=30  → ALB deregistration complete
    t=30+ → ECS sends SIGTERM to container

  CRITICAL INSIGHT:
    Deregistration happens BEFORE SIGTERM.
    By the time your app receives SIGTERM, ALB has already stopped sending new requests.
    Your app just needs to finish the requests it already has.

CONFIGURE DEREGISTRATION DELAY:
  resource "aws_lb_target_group" "api" {
    name     = "api-prod"
    # ...
    deregistration_delay = 30   # seconds to drain before marking deregistered
    # default is 300 seconds (5 minutes) — often too long for modern apps
  }

  Rule:
    deregistration_delay should match your max request duration.
    REST API with max 5-second requests: set to 10-15 seconds.
    Long-polling or file upload endpoints: set higher (60-120 seconds).
    Default 300 seconds: bloats deployments unnecessarily. Reduce it.

WHY THE SEQUENCE MATTERS:
  If SIGTERM arrives BEFORE ALB draining completes:
    New requests can still be routed to the task while it's shutting down.
    Those requests fail (server already closed).
    Solution: ensure deregistration_delay + graceful shutdown window < stopTimeout.

  In practice:
    ECS handles the deregistration order automatically.
    But custom deployment tools or manual task kills (aws ecs stop-task) skip deregistration.
    Always stop tasks via the ECS service, not by manually stopping individual tasks.
```

---

### Background Workers and Queue Processors

```
PROBLEM: HTTP server graceful shutdown is well-understood.
But what about background workers polling SQS?

// worker.ts — SQS worker with graceful shutdown

import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';

const sqs = new SQSClient({ region: 'us-east-1' });
let isShuttingDown = false;

async function processMessage(message: any): Promise<void> {
  // ... process order, send email, whatever ...
  logger.info({ event: 'message_processed', messageId: message.MessageId });

  await sqs.send(new DeleteMessageCommand({
    QueueUrl: process.env.QUEUE_URL!,
    ReceiptHandle: message.ReceiptHandle
  }));
}

async function pollQueue(): Promise<void> {
  while (!isShuttingDown) {
    const response = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: process.env.QUEUE_URL!,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 20,     // long polling — reduces empty receives
      VisibilityTimeout: 30    // seconds before message becomes visible again
    }));

    if (response.Messages?.length) {
      for (const message of response.Messages) {
        if (isShuttingDown) break;  // stop processing mid-batch if shutting down
        await processMessage(message);
      }
    }
  }
  logger.info({ event: 'worker_polling_stopped' });
}

// Graceful shutdown for worker:
async function shutdown(signal: string): Promise<void> {
  logger.info({ event: 'worker_shutdown_initiated', signal });
  isShuttingDown = true;
  // pollQueue will finish its current message then exit the while loop.
  // SQS message visibility timeout = 30s.
  // If we don't complete processing in 30s, message becomes visible again for retry.
  // This prevents message loss even on SIGKILL.

  // Give in-progress message time to complete:
  await new Promise(resolve => setTimeout(resolve, 25_000));
  logger.info({ event: 'worker_shutdown_complete' });
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Start the worker:
pollQueue().catch(err => {
  logger.error({ event: 'worker_fatal', error: err.message });
  process.exit(1);
});

// KEY: message visibility timeout acts as a safety net.
// Even if we SIGKILL mid-processing: message becomes visible again after 30s.
// SQS provides at-least-once delivery — design your workers to be idempotent.
```

---

### Graceful Shutdown with Fastify

```typescript
// Fastify has built-in graceful shutdown support:

import Fastify from "fastify";
import { pool } from "./db";

const fastify = Fastify({ logger: true });

// Register routes...

const start = async () => {
  await fastify.listen({ port: 8080, host: "0.0.0.0" });
};

// Fastify graceful close:
const closeGracefully = async (signal: string) => {
  fastify.log.info({ event: "shutdown_initiated", signal });

  // fastify.close() stops accepting new connections and waits for in-flight requests:
  await fastify.close();

  // Close other resources:
  await pool.end();

  fastify.log.info({ event: "shutdown_complete" });
  process.exit(0);
};

process.on("SIGTERM", () => closeGracefully("SIGTERM"));
process.on("SIGINT", () => closeGracefully("SIGINT"));

start().catch((err) => {
  fastify.log.error(err);
  process.exit(1);
});
```

---

### Production Readiness Checklist

```
SIGNAL HANDLING
  [ ] SIGTERM handler registered in application
  [ ] SIGINT handler registered (for development/debugging)
  [ ] uncaughtException handler logs error before shutdown
  [ ] Signal handlers call the same graceful shutdown function (DRY)

SERVER SHUTDOWN
  [ ] server.close() called first (stop accepting new connections)
  [ ] In-flight requests allowed to complete (do NOT call .destroy())
  [ ] Forced timeout < ECS stopTimeout (avoid SIGKILL during cleanup)

RESOURCE CLEANUP
  [ ] Database connection pool closed via pool.end()
  [ ] Redis/cache client disconnected
  [ ] Log buffers flushed (pino.flush())
  [ ] Any open file handles or streams closed

ECS CONFIGURATION
  [ ] stopTimeout set > graceful shutdown timeout (add 5-10s buffer)
  [ ] ALB deregistration_delay matches max request duration
  [ ] Logging: shutdown events logged with structured fields for post-incident review

VALIDATION
  [ ] Manually test: kill -SIGTERM <pid> → verify in-flight requests complete
  [ ] Verify logs show shutdown_initiated → shutdown_complete sequence
  [ ] Verify no errors in DB or queues from abrupt shutdown in staging deploys
```
