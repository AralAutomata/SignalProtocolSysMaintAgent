# Build Phase 1.0 — Local Signal-Compatible Relay

This document explains Phase 1.0 in simple terms and logs every step needed to reproduce the build. Phase 1.0 adds a **local relay server** that mimics how real Signal clients exchange encrypted messages, but all traffic stays on your laptop.

## What Phase 1.0 Builds
- A minimal **Relay Server** with:
  - HTTP+JSON endpoints for registration, prekeys, and message submission.
  - WebSocket delivery for push-based messaging.
  - SQLite persistence for users, prekeys, and queued messages.
- Updated CLI with networking commands to talk to the relay.
- Docker service for the relay.
- One-command Relay E2E test.

## How Phase 1.0 Works (High-Level)
1. Alice and Bob generate keys locally in their encrypted SQLite DBs.
2. Each client registers with the relay server.
3. Each client uploads a prekey bundle to the relay.
4. When Bob sends a message:
   - The CLI encrypts the message locally.
   - The relay stores and pushes the encrypted envelope to Alice.
5. Alice’s CLI decrypts it locally and prints plaintext.

The relay **never sees plaintext**. It only transports ciphertext envelopes.

## New Components Created
- `packages/relay-server`  
  The local relay server.
- `infra/docker/relay-server/Dockerfile`  
  Docker image for the relay server.
- `scripts/e2e-relay.sh`  
  One-command end-to-end relay test.
- CLI networking commands under `mega client ...`

## Phase 1.0 Build Log and Steps

### Step 1 — Install dependencies
We added server and websocket dependencies and installed:

```bash
npm install
```

If npm cache permissions fail:
```bash
npm --cache /tmp/npm-cache install
```

### Step 2 — Build the workspace
```bash
npm run build
```

### Step 3 — Start the relay server (Docker)
```bash
docker compose up -d relay
```

### Step 4 — Run clients in separate terminals

Terminal A (Alice):
```bash
MEGA_PASSPHRASE=alpha docker compose run --rm cli init --id alice --db /home/node/.mega/alice.db
MEGA_PASSPHRASE=alpha docker compose run --rm cli client register --id alice --server http://relay:8080
MEGA_PASSPHRASE=alpha docker compose run --rm cli client prekeys upload --server http://relay:8080 --db /home/node/.mega/alice.db
MEGA_PASSPHRASE=alpha docker compose run --rm cli client listen --id alice --server http://relay:8080
```

Terminal B (Bob):
```bash
MEGA_PASSPHRASE=alpha docker compose run --rm cli init --id bob --db /home/node/.mega/bob.db
MEGA_PASSPHRASE=alpha docker compose run --rm cli client register --id bob --server http://relay:8080
MEGA_PASSPHRASE=alpha docker compose run --rm cli client prekeys upload --server http://relay:8080 --db /home/node/.mega/bob.db
MEGA_PASSPHRASE=alpha docker compose run --rm cli client send --to alice --server http://relay:8080 --db /home/node/.mega/bob.db --in /tmp/plain.txt
```

Alice will see the decrypted message printed in her terminal.

### Step 5 — One-command Relay E2E test
```bash
npm run test:e2e:relay
```

Optional flags:
```bash
MEGA_PASSPHRASE=alpha npm run test:e2e:relay
SKIP_DOCKER_BUILD=1 npm run test:e2e:relay
```

## Relay Server API (Phase 1.0)
- `POST /v1/register`  
  Body: `{ "id": "alice" }`
- `POST /v1/prekeys`  
  Body: `{ "id": "alice", "bundle": { ... } }`
- `GET /v1/prekeys/:id`
- `POST /v1/messages`  
  Body: `{ "from": "alice", "to": "bob", "envelope": { ... } }`
- WebSocket: `ws://host:8080/ws?client_id=alice`

## Persistence Schema (SQLite)
- `users(id TEXT PRIMARY KEY, created_at INTEGER)`
- `prekeys(id TEXT PRIMARY KEY, bundle_json TEXT, updated_at INTEGER)`
- `messages(id TEXT PRIMARY KEY, to_id TEXT, from_id TEXT, envelope_json TEXT, created_at INTEGER, delivered INTEGER)`

## Troubleshooting Notes From Phase 1.0

### WebSocket connects but no messages appear
Ensure `client listen` uses the **same ID** that was registered and that Bob sends to that ID.

### Missing `client` command in CLI
This indicates an old CLI image. Rebuild:
```bash
docker compose build cli
```
Or run:
```bash
npm run test:e2e:relay
```
Which builds both relay and CLI images.

### DNS / npm registry errors
If you see `EAI_AGAIN`, retry with:
```bash
npm --cache /tmp/npm-cache install
```

## Reproducing Phase 1.0 (Recommended)
For the shortest reproducible path:
```bash
npm install
npm run build
npm run test:e2e:relay
```

That is the complete Phase 1.0 build log and reproduction guide.
