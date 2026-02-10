# Signal-Protocol E2EE + SysMaint Agentic Operations

This repository implements a local-first secure messaging and operations system that combines:

- End-to-end encrypted messaging via the **official Signal library** (`@signalapp/libsignal-client`)
- A local relay for registration, prekey lookup, queueing, and WebSocket fanout
- A SysMaint agent that receives encrypted telemetry and encrypted chat prompts, then responds using LangChain + OpenAI
- A Next.js UI for dashboarding, AI chat, and Alice/Bob E2EE demo conversations

The cryptographic primitives and protocol logic for transport-level E2EE come from libsignal. This repo does not reimplement Signal cryptography.

  cp .env.example .env
  nano .env

  Set at least:

  OPENAI_API_KEY=your_openai_api_key
  MEGA_PASSPHRASE=alpha
  OPENAI_MODEL=gpt-4o-mini
  OPENAI_INPUT_USD_PER_1M=0.15
  OPENAI_OUTPUT_USD_PER_1M=0.60

  Build local package artifacts (required from clean source):

  npm ci
  npm run build

  Start full stack:

  docker compose down --remove-orphans
  docker compose up -d --build relay sysmaint-agent diag-probe sysmaint-web
  docker compose ps

  Test chat API:

  curl -sS -X POST http://localhost:3000/api/chat \
    -H 'Content-Type: application/json' \
    -d '{"prompt":"System status summary in one line."}'

  Open UI:

  - http://localhost:3000
  - http://localhost:3000/chat
  - http://localhost:3000/demo

  Useful logs:

  docker compose logs -f --tail=200 relay sysmaint-agent sysmaint-web diag-probe

  Stop:

  docker compose down

## Table Of Contents
- Architecture Overview
- Open-Source Libraries Used
- Encryption And Security Model
- Signal Protocol Utilization In This Codebase
- LangChain Integration (SysMaint Agent)
- Service And Data-Flow Design
- Repository Structure
- Environment Variables
- Build And Run (From Scratch)
- Common Workflows
- API Surface
- Persistence Model
- Troubleshooting
- Security Notes And Production Hardening

## Architecture Overview

### High-level services
- `relay`: HTTP + WebSocket service for identity registration, prekey distribution, message queueing, and delivery
- `cli`: command-line interface for identity init, bundle export/import, session bootstrap, and encrypted send/listen flows
- `sysmaint-agent`: Signal identity `sysmaint`; decrypts inbound Signal envelopes and handles telemetry/chat logic
- `diag-probe`: Signal identity `diagprobe`; samples host/relay metrics and sends encrypted telemetry reports to `sysmaint`
- `sysmaint-web`: Next.js app exposing:
  - dashboard (`/`) with status + token/spend counters
  - Alice <-> SysMaint chat (`/chat`)
  - 3-panel Alice/Bob/SysMaint demo (`/demo`)

### Core packages
- `packages/signal-core`: shared Signal operations, encrypted store, key/session management, bundle handling
- `packages/relay-server`: local relay implementation
- `packages/sysmaint-protocol`: typed message contracts (`chat.prompt`, `chat.reply`, `telemetry.report`, etc.)
- `packages/shared`: envelope schema and shared helpers

## Open-Source Libraries Used

### Signal / cryptography
- `@signalapp/libsignal-client` (official Signal implementation)
  - session establishment and message cryptography
  - prekey message handling and session message handling
  - identity key pair, signed prekeys, one-time prekeys, and Kyber prekey support

### Agent / LLM
- `@langchain/core`
- `@langchain/openai`

### Platform / infra
- `next`, `react`, `react-dom`
- `ws`
- `better-sqlite3`
- `zod`
- `tsx`, `typescript`

## Encryption And Security Model

### 1) Transport E2EE (Alice/Bob/SysMaint messages)
All application messages between identities are encrypted with Signal sessions through `@signalapp/libsignal-client`.

Message creation path:
- `encryptMessage(...)` in `packages/signal-core/src/index.ts`
- uses libsignal `signalEncrypt(...)`
- outputs an envelope:
  - `senderId`
  - `recipientId`
  - `sessionId`
  - `type` (prekey or session/whisper)
  - `body` (base64 encrypted payload)
  - `timestamp`

Message decryption path:
- `decryptMessage(...)` in `packages/signal-core/src/index.ts`
- uses:
  - `signalDecryptPreKey(...)` when envelope type is prekey
  - `signalDecrypt(...)` when envelope type is normal session/whisper

### 2) Session bootstrap material
Bundles published to relay include:
- identity key
- signed prekey (+ signature)
- one-time prekey
- Kyber prekey (+ signature)

This is built in `exportBundle(...)` and consumed by `initSession(...)` via `processPreKeyBundle(...)`.

### 3) At-rest encryption for local Signal store
Local key/session data is encrypted in SQLite via:
- `AES-256-GCM` (`createCipheriv("aes-256-gcm", ...)`) in `packages/signal-core/src/crypto.ts`
- key derivation: `scrypt` with params:
  - `N = 16384`
  - `r = 8`
  - `p = 1`
  - key length `32`

Important: this at-rest encryption is separate from Signal transport E2EE.

### 4) What the relay can and cannot see
Relay can see:
- sender id, recipient id
- registration and prekey metadata
- encrypted envelope metadata fields

Relay cannot see:
- plaintext chat prompts
- plaintext chat replies
- plaintext telemetry content

All of those are inside encrypted envelope payloads.

## Signal Protocol Utilization In This Codebase

### Identity bootstrap
Used by CLI, web, sysmaint-agent, and diag-probe:
1. `initializeIdentity(...)`
2. `generatePreKeys(...)`
3. register on relay (`POST /v1/register`)
4. upload latest bundle (`POST /v1/prekeys`)

### Session establishment
When a sender has no local session for a peer:
1. fetch peer bundle (`GET /v1/prekeys/:id`)
2. `initSession(...)` creates local session state from prekey bundle

### Message exchange
1. serialize typed app payload (chat/telemetry/direct-message object)
2. Signal-encrypt payload
3. relay via `POST /v1/messages`
4. receiver gets delivery over WebSocket `/ws?client_id=...`
5. receiver Signal-decrypts envelope body
6. receiver handles typed message by `kind`

### Typed application messages (sysmaint protocol)
Defined in `packages/sysmaint-protocol/src/index.ts`:
- `chat.prompt`
- `chat.reply`
- `telemetry.report`
- `control.ping`

## LangChain Integration (SysMaint Agent)

`apps/sysmaint-agent/src/index.ts` provides an always-on encrypted assistant.

### Model layer
- `ChatOpenAI` (model from `OPENAI_MODEL`, default `gpt-4o-mini`)
- low temperature (`0.1`) for operations consistency

### Tooling layer
Three LangChain tools are registered:
- `get_current_status`
- `get_recent_status_history`
- `get_anomaly_summary`

Tool outputs are persisted in SQLite (`tool_calls` table) with request ids.

### Tool-call loop
- agent binds tools, invokes model
- if tool calls are returned, executes and appends `ToolMessage`
- repeats up to 5 tool steps
- returns final assistant response text

### Usage and spend tracking
For each outbound assistant reply:
- extracts token usage metadata from model response
- computes estimated cost with configurable per-1M token rates:
  - `OPENAI_INPUT_USD_PER_1M`
  - `OPENAI_OUTPUT_USD_PER_1M`
- persists usage in `chat_messages`

Dashboard aggregates these into request/token/spend cards and supports a usage reset marker.

## Service And Data-Flow Design

### A) Alice -> SysMaint chat (E2EE)
1. `/chat` UI posts prompt to `POST /api/chat`
2. web API (`apps/sysmaint-web/lib/signal.ts`) ensures Alice identity + session to SysMaint
3. prompt packed as `chat.prompt`, encrypted, sent to relay
4. sysmaint-agent receives, decrypts, runs LangChain/tools, emits `chat.reply`
5. web API waits on Alice WebSocket for matching `requestId` reply
6. UI displays decrypted response

### B) diag-probe -> SysMaint telemetry (E2EE)
1. diag-probe samples `/proc` host metrics + relay diagnostics
2. packs `telemetry.report`
3. Signal-encrypts to sysmaint identity
4. sysmaint-agent decrypts and writes snapshots to state DB
5. dashboard reads latest snapshots and recent history via web API

### C) Alice <-> Bob demo direct chat (E2EE)
1. `/demo` calls `POST /api/e2ee/send`
2. web backend encrypts direct `user.chat.v1` payload to peer
3. receiver-side messages are pulled over short-lived WebSocket polling (`GET /api/e2ee/pull`)
4. center panel can independently chat with SysMaint

## Repository Structure

```text
apps/
  cli/
  diag-probe/
  sysmaint-agent/
  sysmaint-web/
packages/
  relay-server/
  shared/
  signal-core/
  sysmaint-protocol/
infra/
  docker/
  diagnostics/
scripts/
  e2e-docker.sh
  e2e-relay.sh
```

## Authored File Reference (Detailed)

This section explains the purpose of each authored file currently in this repository (excluding generated artifacts such as `node_modules`, `.next`, `dist`, and cache/build metadata).

### Root files
- `.dockerignore` - Reduces Docker build context size and prevents unnecessary/local files from being sent into image builds.
- `.gitignore` - Defines local/generated files that should not be tracked by Git.
- `BuildPhase0.md` - Phase log and implementation notes for the initial project milestone.
- `BuildPhase10.md` - Phase log capturing decisions, progress, and outcomes for phase 10.
- `BuildPhase11.md` - Phase log documenting the phase 11 work and validation notes.
- `BuildPhase12.md` - Phase log documenting phase 12 execution details and outcomes.
- `BuildPhase13.md` - Phase log documenting phase 13 work, fixes, and checkpoints.
- `README.md` - Primary project documentation (architecture, crypto model, setup/runbook, troubleshooting).
- `docker-compose.yml` - Service orchestration for relay, CLI, SysMaint agent, diag probe, web UI, and utility containers.
- `package-lock.json` - Exact dependency lockfile for deterministic installs across environments.
- `package.json` - Workspace root manifest with scripts for build/dev/test and workspace package coordination.
- `tsconfig.base.json` - Shared TypeScript compiler baseline inherited by workspace packages/apps.
- `tsconfig.json` - Root TypeScript project references entrypoint used by `tsc -b`.

### `apps/cli`
- `apps/cli/package.json` - CLI package manifest, dependency declarations, and execution metadata.
- `apps/cli/src/index.ts` - Main CLI implementation for identity init, bundle/session operations, encrypt/decrypt, relay client flows, listen/send/inbox/admin diagnostics.
- `apps/cli/tsconfig.json` - TypeScript config for CLI compilation and project-reference integration.

### `apps/diag-probe`
- `apps/diag-probe/package.json` - diag-probe app manifest and runtime dependencies.
- `apps/diag-probe/src/index.ts` - Telemetry collector service that samples host/relay metrics, wraps them as typed `telemetry.report` messages, Signal-encrypts, and sends to SysMaint.
- `apps/diag-probe/tsconfig.json` - TypeScript config for diag-probe build behavior.

### `apps/sysmaint-agent`
- `apps/sysmaint-agent/package.json` - SysMaint agent manifest including LangChain/OpenAI and Signal dependencies.
- `apps/sysmaint-agent/src/index.ts` - Core SysMaint runtime: Signal bootstrap, encrypted message listener, telemetry persistence, LangChain tool-calling assistant, encrypted chat replies, and token/cost tracking.
- `apps/sysmaint-agent/tsconfig.json` - TypeScript config for the SysMaint agent app.

### `apps/sysmaint-web` application routes
- `apps/sysmaint-web/app/layout.tsx` - Global Next.js layout, top navigation, and app shell.
- `apps/sysmaint-web/app/globals.css` - Global visual system, dashboard styling, chat layout, and three-panel demo responsive behavior.
- `apps/sysmaint-web/app/page.tsx` - Dashboard UI for system metrics, relay stats, LLM usage/spend summaries, and usage reset action.
- `apps/sysmaint-web/app/chat/page.tsx` - Alice <-> SysMaint chat page with quick prompts and encrypted request/reply workflow.
- `apps/sysmaint-web/app/demo/page.tsx` - Three-panel demo page (Alice/Bob direct Signal chat + center SysMaint panel), including auto status prompts and polling logic.

### `apps/sysmaint-web` API routes
- `apps/sysmaint-web/app/api/chat/route.ts` - API endpoint that accepts a prompt and returns SysMaint’s encrypted reply via web-side Signal client logic.
- `apps/sysmaint-web/app/api/e2ee/send/route.ts` - API endpoint for Alice/Bob direct encrypted message send.
- `apps/sysmaint-web/app/api/e2ee/pull/route.ts` - API endpoint for short-window pull of direct encrypted messages for a demo user.
- `apps/sysmaint-web/app/api/status/current/route.ts` - API endpoint exposing latest telemetry snapshot and aggregated token/spend usage.
- `apps/sysmaint-web/app/api/status/history/route.ts` - API endpoint exposing bounded telemetry history window for charts/trends.
- `apps/sysmaint-web/app/api/status/usage/reset/route.ts` - API endpoint that records a usage-reset marker to restart token/cost counters from a chosen timestamp.

### `apps/sysmaint-web` libraries and config
- `apps/sysmaint-web/lib/config.ts` - Centralized environment/config resolution (IDs, relay URL, DB paths, timeouts).
- `apps/sysmaint-web/lib/signal.ts` - Alice-side Signal helper layer for SysMaint chat: bootstrap, session ensure, encrypted send, and reply wait loop.
- `apps/sysmaint-web/lib/e2ee-chat.ts` - Alice/Bob direct E2EE helper layer for demo APIs, including bootstrap/session handling and message pull over WebSocket.
- `apps/sysmaint-web/lib/state-db.ts` - SQLite read/aggregation layer for dashboard data: snapshots, usage totals, and usage reset windows.
- `apps/sysmaint-web/next.config.mjs` - Next.js build config, including workspace package transpilation settings.
- `apps/sysmaint-web/package.json` - SysMaint web app manifest and scripts (`dev`, `build`, `start`).
- `apps/sysmaint-web/tsconfig.json` - TypeScript config for web app compilation/type checking.

### `infra/diagnostics`
- `infra/diagnostics/metrics.ts` - Deno-based diagnostics worker script for collecting host metrics and publishing them to relay diagnostics endpoints.

### `infra/docker` Dockerfiles
- `infra/docker/node/Dockerfile` - General Node-based container used for CLI workflows and shared workspace tooling.
- `infra/docker/relay-server/Dockerfile` - Multi-stage relay image build that compiles workspace code and ships minimal runtime artifacts.
- `infra/docker/diag-probe/Dockerfile` - Container image definition for the diag-probe service.
- `infra/docker/sysmaint-agent/Dockerfile` - Container image definition for the SysMaint agent service.
- `infra/docker/sysmaint-web/Dockerfile` - Container image definition for the Next.js SysMaint web service.
- `infra/docker/diagnostics/Dockerfile` - Container image definition for diagnostics worker/runtime.
- `infra/docker/bun/Dockerfile` - Utility container for Bun-based experimentation/tasks in the same workspace.
- `infra/docker/deno/Dockerfile` - Utility container for Deno-based tooling/scripts.

### `packages/relay-server`
- `packages/relay-server/package.json` - Relay package manifest and runtime dependency declaration.
- `packages/relay-server/src/index.ts` - Relay server implementation (HTTP + WebSocket), message queueing/delivery, prekey storage, registration, and diagnostics endpoints.
- `packages/relay-server/tsconfig.json` - TypeScript config for relay build output.

### `packages/shared`
- `packages/shared/package.json` - Shared package manifest used by multiple apps/packages.
- `packages/shared/src/envelope.ts` - Canonical envelope schema (`zod`) and parser used across sender/relay/receiver boundaries.
- `packages/shared/src/index.ts` - Shared package export surface for common types/helpers.
- `packages/shared/tsconfig.json` - TypeScript config for shared package compilation.

### `packages/signal-core`
- `packages/signal-core/package.json` - Signal-core package manifest exposing compiled library API.
- `packages/signal-core/src/crypto.ts` - At-rest cryptography utilities (`scrypt` key derivation, `AES-256-GCM` encrypt/decrypt, serialization helpers).
- `packages/signal-core/src/store.ts` - Encrypted SQLite-backed Signal stores (identity/session/prekey/signed-prekey/kyber-prekey adapters for libsignal interfaces).
- `packages/signal-core/src/index.ts` - High-level Signal operations: identity bootstrap, prekey generation/export, session init, encrypt/decrypt, envelope loading, inbox helpers.
- `packages/signal-core/test/crypto.test.ts` - Unit tests validating crypto helper correctness and invariants.
- `packages/signal-core/tsconfig.json` - TypeScript config for signal-core package build.

### `packages/sysmaint-protocol`
- `packages/sysmaint-protocol/package.json` - Protocol package manifest for SysMaint message contracts.
- `packages/sysmaint-protocol/src/index.ts` - Typed message schemas/types and encode/decode helpers for SysMaint chat/telemetry/control protocol payloads.
- `packages/sysmaint-protocol/tsconfig.json` - TypeScript config for sysmaint-protocol package.

### `scripts`
- `scripts/e2e-docker.sh` - Automated phase-zero style end-to-end Docker test for local identity/session/encrypt/decrypt flow.
- `scripts/e2e-relay.sh` - Automated relay E2E test that starts relay, registers users, sends encrypted message, and verifies listener receipt.

## Environment Variables

### Global/common
- `MEGA_PASSPHRASE`: passphrase for encrypted local Signal stores

### Relay
- `RELAY_PORT` (default `8080`)
- `RELAY_DB` (default `/data/relay.db` in container)

### SysMaint agent
- `OPENAI_API_KEY` (required)
- `OPENAI_MODEL` (default `gpt-4o-mini`)
- `OPENAI_INPUT_USD_PER_1M` (default `0.15`)
- `OPENAI_OUTPUT_USD_PER_1M` (default `0.60`)
- `SYSMAINT_ID` (default `sysmaint`)
- `SYSMAINT_SIGNAL_DB`
- `SYSMAINT_STATE_DB`

### diag-probe
- `DIAG_PROBE_ID` (default `diagprobe`)
- `SYSMAINT_PROBE_INTERVAL_MS` (default `10000`)
- `DIAG_PROBE_SIGNAL_DB`

### sysmaint-web
- `ALICE_ID` (default `alice`)
- `BOB_ID` (default `bob`)
- `SYSMAINT_WEB_SIGNAL_DB`
- `BOB_SIGNAL_DB`
- `SYSMAINT_CHAT_TIMEOUT_MS` (default `25000`)
- `SYSMAINT_STATE_DB`

## Build And Run (From Scratch)

### Prerequisites
- Node.js `>=24`
- Docker Engine + Docker Compose

### 1) Install and compile local workspace
Required when starting from source-only files because several workspace packages export `dist/*`.

```bash
npm ci
npm run build
```

### 2) Start full stack
```bash
export OPENAI_API_KEY=<your_key>
export MEGA_PASSPHRASE=alpha

docker compose down --remove-orphans
docker compose up -d --build relay sysmaint-agent diag-probe sysmaint-web
docker compose ps
```

### 3) Access
- Dashboard: `http://localhost:3000`
- Alice/SysMaint chat: `http://localhost:3000/chat`
- 3-panel demo: `http://localhost:3000/demo`

### 4) Basic health checks
```bash
curl -s http://localhost:8080/health
curl -s http://localhost:8080/diagnostics
curl -s http://localhost:3000/api/status/current
```

## Common Workflows

### CLI-only local encryption demo
```bash
MEGA_PASSPHRASE=alpha node apps/cli/dist/index.js init --id alice
MEGA_PASSPHRASE=alpha node apps/cli/dist/index.js bundle export --out /tmp/alice.bundle.json
```

### Relay E2E tests
```bash
npm run test:e2e:docker
npm run test:e2e:relay
```

### Local dev (no Docker)
```bash
npm run dev:relay
npm run sysmaint:agent
npm run sysmaint:probe
npm run sysmaint:web:dev
```

## API Surface

### Relay (`packages/relay-server`)
- `GET /health`
- `GET /diagnostics`
- `POST /diagnostics/metrics`
- `POST /v1/register`
- `POST /v1/prekeys`
- `GET /v1/prekeys/:id`
- `POST /v1/messages`
- `WS /ws?client_id=<id>`

### SysMaint web API (`apps/sysmaint-web`)
- `POST /api/chat` (Alice -> SysMaint prompt/reply)
- `POST /api/e2ee/send` (Alice/Bob direct message send)
- `GET /api/e2ee/pull?user=alice|bob` (pull direct messages)
- `GET /api/status/current`
- `GET /api/status/history`
- `POST /api/status/usage/reset`

## Persistence Model

### Relay DB
- `users`
- `prekeys`
- `messages`

### SysMaint state DB
- `snapshots`
- `chat_messages` (includes usage + estimated cost columns)
- `tool_calls`
- `usage_resets`

### Signal encrypted stores
Each identity uses its own encrypted SQLite file (example in Docker):
- `/home/node/.mega/alice-web.db`
- `/home/node/.mega/bob-web.db`
- `/home/node/.mega/sysmaint.db`
- `/home/node/.mega/diagprobe.db`

## Troubleshooting

### `Module not found: Can't resolve '@mega/signal-core'`
Cause: workspace package exports point at `dist/*`, but dist not compiled yet.

Fix:
```bash
npm ci
npm run build
docker compose up -d --build
```

### `/api/chat` timeout waiting for reply
Check:
```bash
docker compose logs --tail=200 sysmaint-agent sysmaint-web relay
```

Typical causes:
- missing/invalid `OPENAI_API_KEY`
- stale local Signal DB state
- concurrent listeners on same identity websocket

Practical reset:
```bash
docker compose down --remove-orphans
docker compose up -d --build relay sysmaint-agent diag-probe sysmaint-web
```

### `PreKey ... not found`
Usually identity/session state drift. Reinitialize affected identity DB(s) and restart service(s).

### Deno diagnostics permission errors
If running Deno scripts directly, include required `--allow-*` flags for env and `/proc` reads.

## Security Notes And Production Hardening

This project is designed for local development and protocol experimentation. Before production use, consider:

- authenticated relay clients and stronger access control
- TLS termination and cert management
- envelope-level replay protection policies and audit trails
- prekey rotation strategy and robust multi-device handling
- secrets management (do not store real keys in `.env.example`)
- centralized observability and alerting
- stronger DoS/rate-limit controls on relay endpoints

## Summary

This codebase demonstrates an end-to-end encrypted operational assistant stack where:

- Signal Protocol secures transport between all identities (Alice, Bob, SysMaint, diagprobe)
- local encrypted stores protect key/session state at rest
- LangChain tools provide grounded operational reasoning over live telemetry
- Next.js surfaces both secure chat and real-time system status in one local workflow
