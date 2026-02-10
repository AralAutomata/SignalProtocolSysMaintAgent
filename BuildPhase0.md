# Build Phase 0 — Minimal Signal CLI (Local-Only)

This document is a step-by-step, beginner-friendly log of everything built in Phase 0. The goal was to create a **minimal CLI client** that exercises the official Signal protocol implementation locally, without any networking. This phase proves encryption, session setup, and decryption all work end-to-end using **official Signal libraries**.

## What Phase 0 Builds
- A CLI app that can:
  - Initialize an identity.
  - Generate prekeys (including PQ/kyber).
  - Export a bundle for a peer.
  - Initialize a session from a peer bundle.
  - Encrypt and decrypt messages locally.
- A shared data model (`Envelope`) for message payloads.
- A secure, encrypted SQLite store for local identity and sessions.
- Docker support for reproducible builds and runs.
- A one-command Docker E2E test.

## Prerequisites
- Node.js `>=24`
- Docker Engine
- `npm` (included with Node.js)

## Key Components Created
- `apps/cli`  
  The CLI tool (`mega`) for local Signal protocol operations.
- `packages/signal-core`  
  Cryptographic operations using `@signalapp/libsignal-client`.
- `packages/shared`  
  Shared `Envelope` schema using `zod`.
- Dockerfiles in `infra/docker/*`  
  Production-style Docker images.
- `docker-compose.yml`  
  Local container orchestration for CLI, Bun, Deno.
- `scripts/e2e-docker.sh`  
  One-command Docker E2E validation.

## Phase 0 Build Log and Steps

### Step 1 — Install dependencies
We installed Node dependencies and pinned the official Signal client library.

```bash
npm install
```

If you see permission errors writing to the npm cache, run:
```bash
npm --cache /tmp/npm-cache install
```

### Step 2 — Build the TypeScript workspace
Phase 0 uses TypeScript project references to build multiple packages.

```bash
npm run build
```

### Step 3 — Initialize identities (local-only)
Create identities and bundles. This is entirely local and uses encrypted SQLite.

```bash
MEGA_PASSPHRASE=alpha node apps/cli/dist/index.js init --id alice
MEGA_PASSPHRASE=alpha node apps/cli/dist/index.js bundle export --out /tmp/alice.bundle.json

MEGA_PASSPHRASE=bravo node apps/cli/dist/index.js init --id bob
MEGA_PASSPHRASE=bravo node apps/cli/dist/index.js bundle export --out /tmp/bob.bundle.json
```

### Step 4 — Initialize sessions
Each side imports the other’s bundle to establish a session.

```bash
MEGA_PASSPHRASE=alpha node apps/cli/dist/index.js session init --their-bundle /tmp/bob.bundle.json
MEGA_PASSPHRASE=bravo node apps/cli/dist/index.js session init --their-bundle /tmp/alice.bundle.json
```

### Step 5 — Encrypt and decrypt locally
This verifies end-to-end correctness using the official Signal protocol library.

```bash
echo "hello" > /tmp/plain.txt
MEGA_PASSPHRASE=alpha node apps/cli/dist/index.js encrypt --to bob --in /tmp/plain.txt --out /tmp/msg.json
MEGA_PASSPHRASE=bravo node apps/cli/dist/index.js decrypt --in /tmp/msg.json --out /tmp/out.txt
cat /tmp/out.txt
```

### Step 6 — Dockerize the CLI
We created a multi-stage Docker build for production-style images and added a persistent volume for encrypted SQLite.

```bash
docker compose build cli
MEGA_PASSPHRASE=alpha docker compose run --rm cli init --id alice
```

### Step 7 — One-command Docker E2E test
This validates the full Alice/Bob flow inside Docker.

```bash
npm run test:e2e:docker
```

Optional flags:
```bash
MEGA_PASSPHRASE=alpha npm run test:e2e:docker
SKIP_DOCKER_BUILD=1 npm run test:e2e:docker
```

## Troubleshooting Notes From Phase 0

### Passphrase mismatch error
If you reuse the same DB with a different passphrase, you’ll see:
```
Error: Unsupported state or unable to authenticate data
```
Fix: Use the original passphrase or a new DB path.

### Bundle export error
`bundle export` does not accept `--id` because it exports the **local** identity in the DB. Use separate DB files for Alice and Bob.

### Session init signature error
We fixed a bug where signed prekeys were signed over the wrong byte representation. The signature now uses `serialize()` for compatibility.

### SQLite cannot open
If you see `SQLITE_CANTOPEN`, the DB path may be broken by shell wrapping. Use variables or quote the full path.

## Reproducing Phase 0 (Recommended)
For the shortest reproducible path:
```bash
npm install
npm run build
npm run test:e2e:docker
```

That is the complete Phase 0 build log and reproduction guide.
