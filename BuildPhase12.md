# Build Phase 1.2 — Stable Operations and Diagnostics Activation

This document logs Phase 1.2 in the same style as previous build phases. The objective here was operational stability: confirm real Alice/Bob messaging over the local relay, harden listener shutdown behavior, and fully activate diagnostics reporting.

## What Phase 1.2 Delivers
- Verified multi-terminal local messaging workflow (Server, Alice, Bob).
- Reliable message input path for Docker CLI (`--in -` via stdin).
- Improved listener shutdown behavior for `client listen` in long-running terminals.
- Working diagnostics sidecar with live metrics reporting.
- A clean reproducible command sequence for daily usage.

## Why This Phase Happened
- Messaging flow was functional but had rough edges in terminal control and file-path assumptions.
- Diagnostics sidecar started but failed due to Deno permission policy (`NotCapable` errors).
- We needed a final "operator-safe" phase log to run and troubleshoot quickly.

## Files and Areas Updated in This Phase Window
- `apps/cli/src/index.ts`
  - Listener shutdown now handles `SIGINT`/`SIGTERM` and closes WebSocket gracefully.
- `infra/docker/diagnostics/Dockerfile`
  - Deno runtime permissions updated so `/proc` and env access work for metrics collection.
- `README.md`
  - Terminal-by-terminal flow updated with stdin send examples and clearer relay usage notes.
- `scripts/e2e-relay.sh`
  - Relay E2E send path moved to stdin piping and no longer depends on host `/tmp` mount.

## Phase 1.2 Build and Run Log

### Step 1 — Build workspace and Docker images
```bash
cd /home/maint/Documents/CodexMultiAgentMCP
npm install
npm run build
docker compose build relay cli diagnostics
```

### Step 2 — Start relay server
Terminal 1:
```bash
cd /home/maint/Documents/CodexMultiAgentMCP
docker compose up relay
```

### Step 3 — Bootstrap Alice and Bob
Terminal 2 (Alice bootstrap):
```bash
cd /home/maint/Documents/CodexMultiAgentMCP
MEGA_PASSPHRASE=alpha docker compose run --rm cli init --id alice --db /home/node/.mega/alice.db
MEGA_PASSPHRASE=alpha docker compose run --rm cli client register --id alice --server http://relay:8080
MEGA_PASSPHRASE=alpha docker compose run --rm cli client prekeys upload --server http://relay:8080 --db /home/node/.mega/alice.db
```

Terminal 3 (Bob bootstrap):
```bash
cd /home/maint/Documents/CodexMultiAgentMCP
MEGA_PASSPHRASE=alpha docker compose run --rm cli init --id bob --db /home/node/.mega/bob.db
MEGA_PASSPHRASE=alpha docker compose run --rm cli client register --id bob --server http://relay:8080
MEGA_PASSPHRASE=alpha docker compose run --rm cli client prekeys upload --server http://relay:8080 --db /home/node/.mega/bob.db
```

### Step 4 — Validate Bob -> Alice messaging
Terminal 2 (listener):
```bash
MEGA_PASSPHRASE=alpha docker compose run --rm cli client listen --id alice --server http://relay:8080 --db /home/node/.mega/alice.db
```

Terminal 3 (send):
```bash
echo "hi alice" | MEGA_PASSPHRASE=alpha docker compose run --rm cli client send --to alice --server http://relay:8080 --db /home/node/.mega/bob.db --in -
```

Expected output in Alice listener:
```text
[bob] hi alice
```

### Step 5 — Validate Alice -> Bob messaging
Stop Alice listener with `Ctrl+C`, then:

Terminal 3 (Bob listener):
```bash
MEGA_PASSPHRASE=alpha docker compose run --rm cli client listen --id bob --server http://relay:8080 --db /home/node/.mega/bob.db
```

Terminal 2 (Alice send):
```bash
echo "hi bob" | MEGA_PASSPHRASE=alpha docker compose run --rm cli client send --to bob --server http://relay:8080 --db /home/node/.mega/alice.db --in -
```

## Diagnostics Activation Log

### Step 6 — Start diagnostics sidecar
```bash
cd /home/maint/Documents/CodexMultiAgentMCP
docker compose up -d diagnostics
docker compose logs -f diagnostics
```

### Step 7 — Verify diagnostics data
CLI view:
```bash
MEGA_PASSPHRASE=alpha docker compose run --rm cli admin diagnostics --server http://relay:8080
```

HTTP view:
```bash
curl -s http://localhost:8080/health
curl -s http://localhost:8080/diagnostics
```

Success condition:
- Diagnostics output includes non-empty metrics fields (cpu/mem/swap/net/load), not `Metrics: none`.

## Operational Troubleshooting Notes

### Listener appears stuck after Ctrl+C
Use another terminal:
```bash
docker ps --filter "name=codexmultiagentmcp-cli-run" --format "table {{.ID}}\t{{.Names}}\t{{.Status}}"
docker stop <container_id>
```
If needed:
```bash
docker kill <container_id>
```

### File input path fails in Docker run
Do not rely on host `/tmp` inside the container unless explicitly mounted. Use stdin:
```bash
echo "message" | ... client send --in -
```

### State mismatch or prekey decrypt errors
Reset and rebuild:
```bash
docker compose down -v --remove-orphans
docker compose build relay cli diagnostics
```

## Verification Snapshot
- Local relay messaging confirmed with decrypted listener output.
- Listener shutdown behavior improved for long-lived sessions.
- Diagnostics sidecar permission issues resolved and metrics path validated.
- Relay E2E path remains reproducible with current scripts.

## Fast Reproduce Path
```bash
cd /home/maint/Documents/CodexMultiAgentMCP
npm install
npm run build
npm run test:e2e:relay
docker compose up -d diagnostics
MEGA_PASSPHRASE=alpha docker compose run --rm cli admin diagnostics --server http://relay:8080
```

That is the complete Phase 1.2 build log.
