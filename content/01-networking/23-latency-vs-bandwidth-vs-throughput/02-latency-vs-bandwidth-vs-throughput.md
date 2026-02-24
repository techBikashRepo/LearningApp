# Latency vs Bandwidth vs Throughput — Part 2 of 3

### Topic: Real-World Examples, System Design Patterns, AWS Mapping, Interview Q&As

**Series:** Networking Fundamentals → System Design → AWS Solutions Architect
**Sections Covered:** 5, 6, 7, 8

---

## SECTION 5 — Real World Examples

### Analogy 1 — The Postal Service (Latency vs Bandwidth vs Throughput)

Imagine sending physical packages via a delivery truck:

**Latency**: The minimum time it takes for ONE package to go from the warehouse to your door. If the route is 200 km and the truck drives at 100 km/h, the _earliest_ package delivery = 2 hours. You cannot reduce this below the physical travel time regardless of how many trucks you add.

**Bandwidth**: The total cargo capacity of all trucks in operation on the route simultaneously. If you have 10 trucks each carrying 5,000 kg, bandwidth = 50,000 kg in transit. If you double the trucks (add more capacity), bandwidth doubles, but package #1 still takes 2 hours.

**Throughput**: The actual number of packages successfully delivered per hour. Maybe two trucks break down (retransmissions), the warehouse sorting system is slow (server processing bottleneck), or customs inspection delays 30% of packages (firewall deep packet inspection). Throughput = what actually gets delivered, not what could theoretically be delivered.

**System design insight**: If customers are complaining that "orders feel slow" — that might be latency (they placed the order and are waiting for confirmation). If customers complain that "checkout fails at peak time" — that's throughput (the system can't handle the volume).

### Analogy 2 — The Hospital Blood Test Lab

A hospital lab receives blood samples from clinics across the city:

**Latency**: How long from when a doctor orders a test to when results appear in the system. This includes: clinic draws blood, courier picks it up, drives to lab (20 min), lab runs test (30 min), results uploaded (5 min). Total latency = ~55 minutes. This time cannot easily be reduced — the chemistry takes 30 minutes regardless.

**Bandwidth**: Total number of samples the lab can have in the processing pipeline simultaneously. Lab has 8 analyzers, each handling 100 samples/hour = 800 samples/hour bandwidth.

**Throughput**: Actual samples processed and results uploaded per hour. If three analyzers break down (hardware failure), throughput = 500 samples/hour despite 800/hour bandwidth capacity. Or if the results-upload software is slow (application bottleneck), even if analyzers finish 800 samples, only 400 get uploaded per hour.

**System design lesson**: You can often improve throughput by fixing bottlenecks (fixing analyzers, improving upload software) without any changes to physical/network infrastructure. Similarly, application-level optimizations (caching, async processing) improve throughput without increasing network bandwidth.

### Real Software Example — Netflix Video Streaming Architecture

Netflix's entire business model depends on optimizing all three metrics simultaneously:

```
Netflix content delivery requirements:
  4K HDR stream: 25 Mbps sustained throughput (no drops, or video quality downgrades)
  Start time: < 2 seconds (latency from "play" click to video starting)
  Error rate: < 0.1% (throughput reliability)

Netflix's Open Connect CDN:
  ~100 PoPs in ISPs' own data centers globally
  ~80% of Netflix traffic served from CDN embedded in ISP networks

  Why embed in ISPs?
  Typical user → ISP network is 1ms (extremely low latency)
  ISP network → Netflix CDN appliance: 5ms (within same building!)
  Total RTT: ~12ms (vs 80ms for content from AWS origin in us-east-1)

  Throughput impact:
    12ms RTT: TCP slow start reaches full speed in milliseconds
    80ms RTT: TCP slow start takes seconds, users see "buffering"

  Bandwidth impact:
    Netflix fills the ISP's CDN appliance overnight with popular content
    During peak hours: content served from local SSD (no internet bandwidth used)
    ISP saves transit bandwidth; Netflix saves AWS data transfer cost

  Adaptive Bitrate (ABR) Streaming:
    Netflix measures throughput in real-time during playback
    If measured throughput drops: switch to lower bitrate profile (1080→720→480p)
    Ensures continuous playback (no stop) at cost of quality reduction

  Split into separate concerns:
    Tile-based streaming: video divided into 2-second segments
    Predictive prefetch: next 3 segments loaded in background before needed
    Buffer: 30 seconds of video buffered → absorbs latency spikes

  Architecture result:
    25 Mbps throughput meets requirement
    Start time < 2s (fast due to CDN locality)
    Resilient to latency spikes (buffer handles them)
    Cost-efficient: ISP CDN avoids expensive cross-internet transit
```

---

## SECTION 6 — System Design Importance

### 1. The Bandwidth vs Latency Decision in System Design

```
Key principle: Choose optimization target based on workload shape:

LATENCY-SENSITIVE workloads (small messages, many of them, need fast response):
  → e-commerce checkout, stock trading, API calls, authentication, DNS queries
  → Optimization: CDN, co-location, caching, async patterns, fewer round trips
  → Bandwidth is irrelevant here (messages are tiny)

BANDWIDTH-SENSITIVE workloads (large payloads, data flows):
  → Video streaming, ML model training, database backups, S3 data lake ingestion
  → Optimization: compression, parallelism, connection pooling, TCP tuning
  → Latency less impactful (data transfer time dominates)

THROUGHPUT-SENSITIVE workloads (high request volume, sustainable rates):
  → High-traffic APIs, Kafka consumers, batch processors
  → Optimization: horizontal scaling, async queues, connection pools, rate limiting
  → Mix of latency AND bandwidth must be considered

Decision matrix:
  "Users click 'pay'" → Latency-sensitive → minimize RTT (CDN, edge functions)
  "Nightly ETL copying 5TB to S3" → Bandwidth-sensitive → tune TCP, use parallel S3 multipart
  "Process 100,000 events/sec from IoT devices" → Throughput-sensitive → Kinesis, partition strategy
```

### 2. Little's Law — Formal Throughput-Latency Relationship

```
Little's Law: L = λ × W
  L = number of requests in the system (queue + being processed) — Concurrency
  λ = throughput (requests/second)
  W = average latency (seconds per request)

Example: E-commerce checkout API
  W = 200ms average response time (0.2 seconds)
  λ = 500 req/s throughput
  L = 500 × 0.2 = 100 concurrent requests in the system

  If you add a slow "fraud detection" service:
    W increases from 200ms to 800ms
    Same λ = 500 req/s
    L = 500 × 0.8 = 400 concurrent requests in the system
    400 threads/connections now needed → resource saturation

  If you have a fixed concurrency limit (thread pool = 200):
    L ≤ 200
    λ ≤ L/W = 200 / 0.8 = 250 req/s
    500 req/s → λ capped at 250 → 250 req/s queue up → queue grows → latency spikes → 503

  Insight: If latency increases (due to DB slowdown, new middleware), throughput decreases
  proportionally (with fixed concurrency). This is why a slow dependency cascades into
  system-wide overload.
```

### 3. Bandwidth Limiting and Traffic Shaping

```
Why limit bandwidth? Fairness and stability:

Without bandwidth limits: one service can saturate the entire link
  Example: nightly backup job starts at 2am
  Without limit: backup uses 10 Gbps → production API traffic gets 0 Gbps → outage
  With traffic shaping: backup gets 2 Gbps → production keeps 8 Gbps → no impact

Token bucket (bandwidth shaping):
  Bucket holds tokens. Each token = 1 byte (or 1 packet) of bandwidth.
  Tokens refill at fixed rate (e.g., 1 Mbps = 125,000 tokens per second)
  Sending a packet: consume tokens. If bucket empty: wait (or drop packet)

  Effect: average rate ≤ token refill rate even if bursts are allowed
  API rate limiting (requests/sec) is the same algorithm applied to request count

QoS (Quality of Service) priority:
  Mark API traffic as high priority, backup as low priority
  Network equipment: serve high-priority queue first
  Effect: latency-sensitive traffic gets < 1ms queueing delay even under load
```

### 4. Bandwidth × Latency Product in Database Design

```
The BDP matters in internal system design too:

MySQL replication: primary sends binlog to replica
  Replication lag = replication throughput limited by BDP (if cross-region)

  Primary: us-east-1
  Replica: eu-west-1
  RTT: 90ms
  Binlog stream bandwidth: 10 Mbps
  BDP = 10 Mbps × 0.09s = 0.9 Mb = 112 KB

  If binlog has burst > 112 KB:
    Replica falls behind → reads from replica could be stale for seconds
    Fix: increase the replication window / use synchronous replication with acknowledgment

  Aurora Global Databases:
    Dedicated storage replication network layer (not application TCP)
    Replicated with <1 second RPO across regions
    Proprietary protocol, not limited by TCP window size constraints
```

---

## SECTION 7 — AWS Mapping

### CloudWatch Metrics for Each Dimension

```
LATENCY metrics in AWS:
  ALB: TargetResponseTime — p50/p95/p99 (milliseconds)
  CloudFront: TimeToFirstByte per distribution (milliseconds)
  Route 53: DNS query latency (CloudWatch → Route53HealthChecks)
  RDS: ReadLatency, WriteLatency (seconds, very granular)
  ElastiCache: CacheHits (binary — was latency near-zero or DB-level?)
  DynamoDB: SuccessfulRequestLatency (per operation type)
    DynamoDB single-digit millisecond for GetItem/PutItem at any scale

  X-Ray: end-to-end and segment-level latency (p50/p95/p99 per service)

BANDWIDTH metrics:
  EC2: NetworkIn, NetworkOut (bytes)
  ELB: ProcessedBytes
  CloudFront: BytesDownloaded, BytesUploaded
  VPC: VPC Flow Logs → bytes per flow
  Direct Connect: ConnectionBpsEgress, ConnectionBpsIngress

THROUGHPUT metrics:
  ALB: RequestCount (requests per second = throughput)
  SQS: NumberOfMessagesSent, NumberOfMessagesReceived (per second = consumer throughput)
  Lambda: Invocations per second = lambda throughput
  Kinesis: GetRecords.IteratorAgeMilliseconds (high = consumer can't keep up with producer throughput)
  RDS: ReadIOPS, WriteIOPS (per second)
  DynamoDB: ConsumedReadCapacityUnits, ConsumedWriteCapacityUnits
```

### AWS Services Organized by Optimization Target

```
LATENCY REDUCTION services:
  CloudFront: edge caching → latency from 50-200ms (origin) to 1-5ms (edge PoP)
  Route 53 Latency-Based Routing: route to lowest-latency AWS region
  ElastiCache (Redis/Memcached): in-memory cache → <1ms vs 10-50ms DB
  DynamoDB Accelerator (DAX): in-memory cache for DynamoDB → <1ms vs 1-3ms DynamoDB
  Lambda@Edge: run code at CloudFront edge → response modified in <1ms at the edge
  CloudFront Functions: even lighter than Lambda@Edge, <1ms execution
  Global Accelerator: routes through AWS backbone (private fiber) → 20-60% lower latency
    vs public internet for non-cacheable content (dynamic APIs, WebSocket)

BANDWIDTH/TRANSFER services:
  S3 Transfer Acceleration: CloudFront edge → S3 backbone for fast uploads
  Direct Connect: dedicated 1/10 Gbps fiber → consistent bandwidth, no internet congestion
  AWS Snow family: physical devices for high-bandwidth on-premises data transfer
    Snowball Edge: 80 TB, faster than any internet connection for >10 TB transfers

THROUGHPUT services:
  Auto Scaling: add instances when throughput demand exceeds capacity
  SQS: decouple producers/consumers; each side scales throughput independently
  Kinesis Data Streams: 1 MB/s per shard ingest; scale shards for more throughput
  Lambda: auto-scales to match throughput demand (1,000+ concurrent executions)
  Aurora Serverless v2: scales DB throughput automatically with ACUs
```

### AWS Global Accelerator vs CloudFront

```
Both reduce latency, but for different use cases:

Global Accelerator:
  Works at Layer 3/4 (TCP/UDP)
  Routes traffic: user → nearest AWS edge PoP → AWS private backbone → your ALB/NLB/EC2
  Benefit: user's packet stays on AWS private network, not public internet
  Static Anycast IPs (2 IPs, always the same): works with on-prem IP whitelists
  Use: dynamic content (APIs that can't be cached), WebSocket, non-HTTP protocols
  Latency improvement: 20-60% for global users vs routing over public internet
  No caching

CloudFront:
  Works at Layer 7 (HTTP/HTTPS)
  Routes traffic: user → nearest edge → (cache hit: immediate; miss: origin)
  Benefit: cache hit = effectively 0 origin traffic + lowest possible latency
  Dynamic IPs (DNS-based): not suitable for IP whitelisting
  Use: cacheable content (HTML, JS, CSS, images, video, API GET responses)
  Latency improvement: cache hit = 1-5ms regardless of origin location

Decision:
  Cacheable HTTP? → CloudFront
  TCP/UDP, WebSocket, dynamic API, needs static IP? → Global Accelerator
  Need BOTH? → Both (CloudFront for static, Global Accelerator for dynamic API)
```

---

## SECTION 8 — Interview Q&As

### Beginner Questions

**Q1: Explain the difference between latency and bandwidth to a non-technical colleague.**

A: Use the highway analogy:

Latency is the time it takes for ONE car to travel from City A to City B. If it's 500 km away and cars drive 100 km/h, latency = 5 hours. This doesn't change whether there's 1 car on the road or 10,000 cars — the individual trip time is the same.

Bandwidth is how many LANES the highway has. More lanes = more cars can travel simultaneously. But adding lanes doesn't make individual cars faster.

Throughput is how many cars actually ARRIVE per hour. Maybe the highway has 10 lanes (high bandwidth) but a bridge at the far end has only 2 lanes — that's a bottleneck. The throughput at the destination is limited by that bridge.

In computing: latency = how long one request takes; bandwidth = max data rate the link can carry; throughput = actual data rate you observe. For web users, latency is usually the pain point (pages feel slow because many small requests accumulate). For bulk data transfer (video encoding, database backups), bandwidth is the constraint.

**Q2: My internet plan says 1 Gbps, but I'm only seeing 50 Mbps when downloading a file. What could explain this?**

A: Multiple reasons:

1. **Server-side limitation**: The server hosting the file may only serve 50 Mbps. Your local internet is 1 Gbps, but the bottleneck is the server's outbound bandwidth. Check with a speed test to another fast server (Cloudflare, Google).

2. **TCP slow start and window size**: TCP starts slowly and ramps up. Small files never reach full speed because they finish during slow start. The 1 MB/s → 2 MB/s → 4 MB/s doubling takes multiple hundreds of milliseconds if the server is far away.

3. **Geographic distance**: Server is in another continent. RTT = 150ms. TCP throughput = Window / RTT. Default 64KB window / 0.15s = 426 KB/s = ~3.4 Mbps. Even with window scaling, reaching 1 Gbps with 150ms RTT needs a 150 MB TCP window.

4. **Link congestion**: Your ISP's backbone is congested (peak hours). Advertised bandwidth is shared, not dedicated.

5. **Single connection limit**: HTTP/1.1 downloads use one TCP connection. HTTP/2 or download managers that split into parallel connections (like AWS CLI S3 multipart) use many connections, achieving near-line-rate download.

6. **Disk speed**: USB 2.0 flash drive max write = 25 MB/s = 200 Mbps. Even if network is 1 Gbps, writing to slow storage caps visible throughput at 200 Mbps.

**Q3: What is jitter and how does it differ from latency?**

A: Latency is the average time for one packet to arrive. Jitter is the variation — how much individual packet latencies differ from the average.

Example: A streaming video call measures RTT on each of 10 consecutive packets:

- Packet 1: 45ms, Packet 2: 47ms, Packet 3: 44ms, ... Packet 8: 145ms, Packet 9: 46ms, Packet 10: 48ms

Average latency: ~52ms. Jitter (standard deviation): ~30ms.

Packet 8 arrived 100ms late compared to the average. This causes:

- Video freezes briefly (packet 8 is playing when the buffer expected it to be there)
- Audio glitches in voice calls
- Gameplay desynchronization

Jitter is caused by queueing delay variation: most packets flow through uncongested routers instantly, but occasionally a burst of traffic fills a router buffer, adding 100ms to those packets.

Mitigation:

- Jitter buffer (receiver waits a bit, absorbs variation): adds fixed latency to handle jitter (VoIP apps use 20-80ms buffers)
- QoS prioritization: voice/video packets go to low-latency queue
- QUIC (HTTP/3): stream-level recovery, so one slow stream doesn't starve others
- AWS: RTSP/WebRTC on CloudFront uses jitter buffers; GameLift and IVS are tuned for real-time

---

### Intermediate Questions

**Q4: How would you design a global API that has < 50ms latency for users in 5 continents?**

A: The physics limit: NY to Sydney = 16,000 km → 80ms minimum RTT (light-speed limit). You CANNOT achieve < 50ms with a single origin in us-east-1 for Australian users. The solution must involve geographic distribution:

```
Approach: Route 53 Latency-Based Routing + Multi-Region Active-Active

Regions: us-east-1, eu-west-1, ap-southeast-1, ap-northeast-1, sa-east-1

For each region:
  ALB → ECS (stateless API) → DynamoDB Global Tables (replicated writes)
  ElastiCache Redis (read cache, region-local)

Route 53 Latency-Based Routing:
  Australian user → ap-southeast-1 (Singapore, ~50ms from Sydney)
  European user → eu-west-1 (Ireland, ~10-30ms from Europe)
  US East user → us-east-1 (~5-15ms from NYC)

Write consistency:
  DynamoDB Global Tables: write to local region → replicates to other regions in ~1 second
  For strong consistency: write to specific primary region (tolerate 50-200ms write latency)
  For eventual consistency: write to local region, read local (fast, but 1s stale possible)

Additional optimization:
  CloudFront + Lambda@Edge: run API logic at edge for truly latency-sensitive endpoints
  (authentication, feature flags, A/B redirects) → <5ms at edge PoPs in 450+ cities

Cost: Multi-region data transfer + replication costs are significant
  Evaluate: is < 50ms worth the 3-5× infrastructure cost?
  Often: 99% of users are in 2-3 regions → deploy to those 3 first
```

**Q5: Your Kafka consumer is falling behind the producer. How does throughput vs latency tradeoff explain this, and how do you fix it?**

A: Consumer lag = consumer throughput < producer throughput. The lag accumulates in the Kafka topic.

```
Diagnosis:
  CloudWatch: Kinesis IteratorAgeMilliseconds → rising = consumer behind
  MSK: KafkaConsumerLag → partition-level, shows which partitions are behind

Root cause analysis:
  1. Throughput mismatch: producer produces 50K events/min, consumer processes 30K events/min
     Net accumulation: 20K events/min behind

  2. Latency inside consumer causing throughput drop:
     Consumer calls external API for each event: 200ms × 30K events = consuming at 5K events/min!
     Solution: batch external API calls, or use async processing

Fixes in order of invasiveness:

Fix 1: Pull larger batches per poll (reduce per-message overhead)
  consumer.poll() returns 500 messages vs 50 → fewer network round trips per event
  max.poll.records = 500 (Kafka config)

Fix 2: Parallel processing within consumer
  Instead of for(msg in batch) { process(msg) } → process in parallel thread pool
  Careful: message ordering guarantee may be needed within a partition

Fix 3: Add consumer instances (horizontal scale)
  Partitions = degree of parallelism. 20 partitions → max 20 consumer instances
  If consumer is bottleneck: scale consumer instances up to partition count

Fix 4: Add partitions to topic (increase parallelism ceiling)
  WARNING: adding partitions changes key→partition mapping (messages may be out-of-order)
  Must be done carefully, with consumer rebalancing awareness

Fix 5: Optimize slow consumer operation
  If bottleneck is DB writes: use batch inserts, async writes, write-ahead buffer
```

**Q6: Explain how to use load testing to jointly understand latency and throughput of a system.**

A: Load testing reveals the latency/throughput curve (the J-curve):

```
Test setup (wrk2 or k6):
  Increase requests/sec from 10 → 100 → 500 → 1,000 → 2,000 → 5,000 req/s
  At each level: measure p50, p95, p99 latency AND throughput (successful responses/sec)

Expected J-curve pattern:
  req/s     p50    p95    p99    success%  errors
  100       15ms   25ms   40ms   100%      0%
  500       16ms   28ms   50ms   100%      0%
  1,000     18ms   35ms   80ms   100%      0%
  2,000     30ms   120ms  500ms  99.5%     0.5% (approaching saturation)
  3,000     200ms  2000ms ∞      60%       40% (saturated! queue filling)

  The "knee": between 1,000 and 2,000 req/s where latency starts rising non-linearly
  Target operating point: typically 70-80% of the knee (1,400 req/s in this example)

Why 70-80%, not 100%? Headroom for:
  Traffic spikes (Black Friday = 3× normal)
  GC pauses (sudden 100ms GC → brief 0 req/s → queue builds → spike)
  Slow queries on cache miss

AWS implementation:
  Auto Scaling: trigger scale-out at 70% CPU/memory (not 100% — scale BEFORE knee)
  Target tracking: "maintain 70% CPU" → ASG adds instances to stay there
  ALB: request count per target → scale when requests/target > set threshold
```

---

### Advanced System Design Questions

**Q7: Design a data pipeline that ingests 10 TB of sensor data per day with < 5ms write latency and < 100ms query latency.**

A: This is a bandwidth + throughput + latency challenge combined:

```
Data profile:
  10 TB / 86,400 seconds = 116 MB/s sustained ingestion bandwidth
  Sensor events: 100-byte each → 10 TB / 100 bytes = 100 billion events/day
  = 1.16 million events/second ingestion rate

Ingestion path (write < 5ms):
  Sensors → Kinesis Data Streams:
    Kinesis: 1 MB/s ingest per shard, 1,000 PUT records/s per shard
    116 shards × 1 MB/s = 116 MB/s capacity (matches requirement)
    Kinesis PUT latency: < 5ms (measured by producer ACK)

  DynamoDB (for hot recent data, query < 1ms):
    Consumer Lambda reads from Kinesis → batches 1,000 events → DynamoDB BatchWriteItem
    DynamoDB: single-digit ms, scales to millions of writes/s with on-demand capacity
    Partition key: sensorId, Sort key: timestamp → efficient time-series queries per sensor

Query path (< 100ms):
  Recent data (last 24h): DynamoDB direct read (1-3ms for GetItem)
  Aggregated/historical (last 30 days):
    Lambda Kinesis consumer → S3 (Parquet, partitioned by sensor/date)
    Athena: query Parquet on S3 → return aggregates in < 100ms for optimized partition scans

  Pre-aggregated metrics: CloudWatch custom metrics or DynamoDB aggregations updated every 60s
  API Gateway → Lambda → DynamoDB → returns 100ms aggregate data

Cost optimization:
  S3 storage: $23/TB/month (vs DynamoDB $0.25/GB/month = $250/TB/month)
  Move data from DynamoDB to S3 after 7 days (DynamoDB TTL → S3 via DynamoDB Streams)

Throughput at query layer:
  API Gateway: auto-scales to 10,000+ req/s
  DynamoDB on-demand: no throughput ceiling (pay per request)
  Athena: concurrent query limit (default 5, request increase)
```

**Q8: Your company's primary bottleneck is "latency of database writes at scale." Describe 3 architectural strategies to address this, each with different tradeoffs.**

A:

**Strategy 1: Write-Ahead Cache (async DB writes)**

```
Client → API → Redis (write here first, return 200 OK immediately)
                  ↓ async
               Lambda/worker reads from Redis → batch-writes to RDS/DynamoDB

Write latency: ~0.3ms to Redis (almost instant)
Risk: Redis failure before batch written = data loss window
Use when: analytics events, counters, metrics (eventual persistence is acceptable)
Not suitable for: financial transactions requiring durability

AWS: ElastiCache Redis → Lambda (triggered by Redis Streams) → RDS
```

**Strategy 2: Horizontal Write Distribution (sharding)**

```
Instead of one master DB receiving all writes:
  Partition writes by key range or hash
  10 RDS instances, each handling writes for customer IDs 0-1M, 1M-2M, ...

Write latency per shard: same as single DB (~5ms)
But: 10× throughput (10 shards handle 10× concurrent writes)

AWS: Aurora Sharding is manual (app-level); or:
     DynamoDB: automatically shards horizontally, no config needed
     Scales to millions of writes/s with consistent <10ms latency

Use when: write throughput is the bottleneck (not per-write latency itself)
```

**Strategy 3: CQRS + Event Sourcing**

```
Separate write model from read model:
  Write path: events written to Kinesis/Kafka at ~1-5ms latency (append-only, no locks)
  Read path: consumers build materialized views in DynamoDB or ElasticSearch

Write latency: Kinesis PUT = <5ms (optimized append to stream)
Query latency: ElasticSearch query = 10-50ms (rich search on pre-built indexes)

Eventual consistency: materialized view is updated asynchronously (typically < 1s)
Use when: write contention causes lock waits (e.g., "Available stock" counter)
         → event stream has no locks, processes events to update stock in background

AWS: Kinesis → Lambda (build materialized view) → DynamoDB → API Gateway → clients
     Event sourcing: all events persisted in S3/DynamoDB Streams for replay
```

---

## File Summary

This file covered:

- Postal service and hospital lab analogies: latency=delivery time, bandwidth=truck capacity, throughput=actual deliveries
- Netflix Open Connect CDN: ISP-embedded PoPs reduce RTT from 80ms to 12ms → enables smooth streaming
- ABR (Adaptive Bitrate) streaming: measures real throughput and downgrades quality vs stopping playback
- Latency vs bandwidth decision matrix: small+frequent→latency-optimize; large+bulk→bandwidth-optimize
- Little's Law: L = λ × W → latency increase with fixed concurrency directly reduces max throughput
- Traffic shaping and token bucket: how bandwidth is controlled in production to protect critical workloads
- BDP in database replication: cross-region replication lag explained by TCP window + high RTT
- AWS: CloudWatch metrics per dimension, latency services (CloudFront, GA, ElastiCache) vs bandwidth services (Direct Connect, S3 Transfer Acceleration)
- Global Accelerator vs CloudFront: L3/L4 private backbone vs L7 edge caching
- 8 Q&As: highway analogy, 1 Gbps slow download causes, jitter definition, global 50ms API, Kafka lag, load testing J-curve, 10TB/day sensor pipeline, 3 write-latency strategies

**Continue to File 03** for AWS SAA exam traps, 5 comparison tables, Quick Revision mnemonics, and Architect Exercise.
