# Build Phase 2.0 — SysMaint Agentic ChatBot with Signal E2EE

This phase implements the first local SysMaint AI stack where Alice talks to SysMaint through Signal-encrypted relay messages, and telemetry is also delivered over Signal.

## What Phase 2.0 Delivers
- New shared protocol package for versioned SysMaint message contracts.
- New `sysmaint-agent` worker:
  - Long-running Signal listener as `sysmaint`.
  - Telemetry ingest into local SQLite status store.
  - LangChain + OpenAI tool-calling agent responses.
  - Encrypted reply path back to `alice`.
- New `diag-probe` worker:
  - Samples host metrics (`/proc` + loadavg).
  - Pulls relay counts from `/diagnostics`.
  - Sends encrypted `telemetry.report` messages to `sysmaint`.
- New `sysmaint-web` Next.js app:
  - Dashboard page for current status snapshots.
  - Chat page for Alice prompts.
  - API route that sends prompts via Signal and waits for encrypted replies.
- Docker Compose wiring for:
  - `sysmaint-agent`
  - `diag-probe`
  - `sysmaint-web`
  - shared `sysmaint-data` volume for Alice/SysMaint/Probe identities and state DB.

## Message Security Model in This Phase
- Chat transport: Signal E2EE (`alice` <-> `sysmaint`).
- Telemetry transport: Signal E2EE (`diagprobe` -> `sysmaint`).
- Relay remains a transport queue/router and does not decrypt payloads.

## New Project Areas
- `packages/sysmaint-protocol`
- `apps/sysmaint-agent`
- `apps/diag-probe`
- `apps/sysmaint-web`
- `infra/docker/sysmaint-agent/Dockerfile`
- `infra/docker/diag-probe/Dockerfile`
- `infra/docker/sysmaint-web/Dockerfile`

## Existing Files Updated
- `docker-compose.yml`
- `package.json`
- `package-lock.json`
- `infra/docker/node/Dockerfile`
- `infra/docker/relay-server/Dockerfile`
- `README.md`

## Runtime Behavior

### Auto-bootstrap behavior (first run)
Each new Signal identity auto-runs:
1. identity init (if missing)
2. relay register (`/v1/register`)
3. prekey generation/upload (`/v1/prekeys`)
4. session init on first conversation with a peer

### SysMaint agent flow
1. Receive Signal envelope over relay websocket.
2. Decrypt envelope payload.
3. Route by protocol kind:
   - `telemetry.report` -> store snapshot in local SQLite.
   - `chat.prompt` -> run LangChain tools -> generate response -> encrypt/send `chat.reply`.

### Alice web chat flow
1. User sends prompt in `/chat`.
2. Web API encrypts prompt as `alice` and posts via relay.
3. API opens websocket listener for `alice`, decrypts incoming messages, and resolves matching `requestId` reply.

## LangChain Integration
- Model: `OPENAI_MODEL` (default `gpt-4o-mini`)
- Tools used by agent:
  - `get_current_status`
  - `get_recent_status_history`
  - `get_anomaly_summary`
- Tool calls are audited in `tool_calls` table.

## Data Storage
- Signal DBs in `/home/node/.mega`:
  - `sysmaint.db`
  - `alice-web.db`
  - `diagprobe.db`
- SysMaint state DB:
  - `sysmaint-state.db` with snapshot + chat + tool call tables.

## Build/Validation Performed
- `npm install --cache /tmp/.npm-cache`
- `npm run build` (root TS project refs)
- `npx tsc --noEmit -p packages/sysmaint-protocol/tsconfig.json`
- `npx tsc --noEmit -p apps/sysmaint-agent/tsconfig.json`
- `npx tsc --noEmit -p apps/diag-probe/tsconfig.json`
- `npx tsc --noEmit -p apps/sysmaint-web/tsconfig.json`
- `npm run sysmaint:web:dev` (startup verified)

## Operational Commands (Phase 2)

### Start stack
```bash
export OPENAI_API_KEY=<your_openai_key>
export MEGA_PASSPHRASE=alpha

docker compose build relay sysmaint-agent diag-probe sysmaint-web
docker compose up -d relay sysmaint-agent diag-probe sysmaint-web
```

### Observe services
```bash
docker compose logs -f sysmaint-agent
docker compose logs -f diag-probe
docker compose logs -f sysmaint-web
```

### Open UI
```text
http://localhost:3000
```

### Quick status API check
```bash
curl -s http://localhost:3000/api/status/current
```

## Web Build Note
- `sysmaint-web` now supports both `next dev` and `next build`/`next start` with project-local default data paths.
- In Docker Compose, runtime paths are still pinned to `/home/node/.mega` via service environment variables.

This is the complete Phase 2.0 implementation log.
