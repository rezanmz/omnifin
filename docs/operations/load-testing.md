# Load testing

Omnifin uses a deterministic loopback load profile as a protected regression gate. It
does not claim a universal production capacity: hardware, proxy topology, SQLite
storage, artwork, media bitrate, connector latency, and concurrent streams all change
an installation's real limit. Release rehearsals must supplement this gate with the
deployment-specific profile described below.

## Protected gateway profile

Build the gateway and run the same profile used by pull-request CI:

```sh
pnpm --filter @omnifin/gateway... build
pnpm load:gateway --report artifacts/load/gateway.json
```

The runner starts a production-configured gateway against a new private SQLite
database, waits for full readiness, warms every route, and then sends 20,000 requests
through 80 concurrent clients. The mixed workload exercises liveness, database
readiness, public authentication-provider discovery, unauthenticated session
inspection, request IDs, security headers, response validation, and rate-limit
accounting. Benchmark-network source addresses model distinct clients behind the one
explicitly trusted reverse-proxy hop; no public network is contacted.

The versioned profile currently requires all of the following on the hosted Linux
runner:

- zero transport, status, or timeout errors;
- at least 250 requests per second;
- p95 latency at or below 150 milliseconds, p99 at or below 400 milliseconds, and no
  request above one second;
- gateway resident memory at or below 384 MiB; and
- no more than 192 MiB of resident-memory growth during the measured interval.

The JSON artifact records the profile, budgets, status counts, latency distribution,
throughput, and memory observations. It contains no database path, encryption key,
cookie, client identifier, or upstream response.

## Deployment-specific rehearsal

Before a release or material capacity change, run a separate isolated environment with
the intended CPU, memory, filesystem, TLS proxy, and connector versions. Use generated,
copyright-free media and synthetic accounts only. Increase load in bounded steps while
observing gateway event-loop delay, process and container memory, SQLite lock time,
proxy saturation, upstream latency, transcoder capacity, playback stalls, and error
rates.

Exercise at least sign-in and account-link reads, dashboard and discovery reads,
request and acquisition mutations, concurrent progress updates, subtitle operations,
range requests, HLS manifests and segments, reconnects, and graceful shutdown under
load. Keep mutation inputs idempotent and run destructive scenarios only against
disposable services.

Stop the rehearsal when any security or correctness invariant fails, when memory grows
without stabilizing, or when the agreed latency and error budgets are exceeded. Retain
the sanitized results with the exact image digest and environment description; do not
publish service URLs, media paths, tokens, cookies, usernames, or OIDC assertions.
