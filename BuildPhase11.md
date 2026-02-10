# Build Phase 1.1 — Inbox, Diagnostics, and Reliability Hardening

This document logs Phase 1.1 updates in the same style as prior phases. The focus here was making local relay usage reliable for real multi-terminal workflows, improving listener shutdown behavior, and fixing diagnostics container permissions so metrics report correctly.

## What Phase 1.1 Adds
- Stable multi-terminal runbook for local relay messaging (Alice, Bob, Server).
- Safer message send flow for Docker runs using stdin (`--in -`) instead of host file paths.
- Graceful CLI listener shutdown (`Ctrl+C` / signals) with fallback exit behavior.
- Working diagnostics sidecar permissions for Deno metrics collection.
- Updated reproducible docs and command logs.

## Why This Phase Was Needed
- Sending `--in /tmp/plain.txt` failed inside `docker compose run` because host `/tmp` is not mounted by default.
- Some `client listen` sessions were hard to stop cleanly in interactive terminal setups.
- Diagnostics container initially failed with Deno `NotCapable` permission errors and never posted metrics.

## Components Updated
- `apps/cli/src/index.ts`
  - Added explicit `SIGINT` / `SIGTERM` handling for `client listen`.
  - Added graceful WebSocket close + forced-exit fallback.
- `scripts/e2e-relay.sh`
  - Switched relay send path to stdin piping (`--in -`).
  - Removed unnecessary `/tmp` bind mount dependency.
- `README.md`
  - Updated Phase 1 flow to terminal-by-terminal server/Alice/Bob commands.
  - Added stdin-based send examples and reverse direction example.
  - Added note explaining Docker host-path visibility caveat.
- `infra/docker/diagnostics/Dockerfile`
  - Updated Deno runtime permissions to allow diagnostics metrics collection.
- `runCommands/phase10run.txt`, `runCommands/phase11run.txt`
  - Synced command examples with stdin send and explicit DB usage.

## Phase 1.1 Build Log and Steps

### Step 1 — Build workspace and images
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

### Step 3 — Initialize Alice and Bob
Terminal 2 (Alice):
```bash
cd /home/maint/Documents/CodexMultiAgentMCP
MEGA_PASSPHRASE=alpha docker compose run --rm cli init --id alice --db /home/node/.mega/alice.db
MEGA_PASSPHRASE=alpha docker compose run --rm cli client register --id alice --server http://relay:8080
MEGA_PASSPHRASE=alpha docker compose run --rm cli client prekeys upload --server http://relay:8080 --db /home/node/.mega/alice.db
```

Terminal 3 (Bob):
```bash
cd /home/maint/Documents/CodexMultiAgentMCP
MEGA_PASSPHRASE=alpha docker compose run --rm cli init --id bob --db /home/node/.mega/bob.db
MEGA_PASSPHRASE=alpha docker compose run --rm cli client register --id bob --server http://relay:8080
MEGA_PASSPHRASE=alpha docker compose run --rm cli client prekeys upload --server http://relay:8080 --db /home/node/.mega/bob.db
```

### Step 4 — Bob sends to Alice
Terminal 2 (listen):
```bash
MEGA_PASSPHRASE=alpha docker compose run --rm cli client listen --id alice --server http://relay:8080 --db /home/node/.mega/alice.db
```

Terminal 3 (send):
```bash
echo "hi alice" | MEGA_PASSPHRASE=alpha docker compose run --rm cli client send --to alice --server http://relay:8080 --db /home/node/.mega/bob.db --in -
```

Expected listener output:
```text
[bob] hi alice
```

### Step 5 — Reverse direction (Alice to Bob)
Stop Alice listener (`Ctrl+C`) and start Bob listener:
```bash
MEGA_PASSPHRASE=alpha docker compose run --rm cli client listen --id bob --server http://relay:8080 --db /home/node/.mega/bob.db
```

Send from Alice:
```bash
echo "hi bob" | MEGA_PASSPHRASE=alpha docker compose run --rm cli client send --to bob --server http://relay:8080 --db /home/node/.mega/alice.db --in -
```

### Step 6 — Start diagnostics and verify metrics
```bash
docker compose up -d diagnostics
docker compose logs -f diagnostics
```

Verify via CLI:
```bash
MEGA_PASSPHRASE=alpha docker compose run --rm cli admin diagnostics --server http://relay:8080
```

Verify via HTTP:
```bash
curl -s http://localhost:8080/health
curl -s http://localhost:8080/diagnostics
```

## Reliability Notes and Troubleshooting

### 1) `/tmp/plain.txt` not found in container
Use stdin:
```bash
echo "message" | ... client send --in -
```

### 2) Listener appears stuck in some TTY sessions
- Current CLI now handles `SIGINT`/`SIGTERM` and closes WebSocket cleanly.
- If terminal still hangs, stop from another terminal:
```bash
docker ps --filter "name=codexmultiagentmcp-cli-run" --format "table {{.ID}}\t{{.Names}}"
docker stop <container_id>
```
Or force:
```bash
docker kill <container_id>
```

### 3) Diagnostics `NotCapable` errors
This phase updated diagnostics container runtime permissions so `/proc` sampling and env reads succeed. Rebuild diagnostics image after pull/update:
```bash
docker compose build diagnostics
docker compose up -d diagnostics
```

### 4) PreKey decryption failures after many retries/runs
If state is stale or mixed from old runs:
```bash
docker compose down -v --remove-orphans
docker compose build relay cli
```
Then re-run the bootstrap sequence.

## Verification Performed
- `bash -n scripts/e2e-relay.sh` passed.
- `npm run test:e2e:relay` passed with updated stdin relay send path.
- Manual relay flow validated with listener output showing decrypted message.
- Diagnostics endpoint and admin output validated after sidecar permissions fix.

## Recommended Reproduce Path
```bash
cd /home/maint/Documents/CodexMultiAgentMCP
npm install
npm run build
npm run test:e2e:relay
docker compose up -d diagnostics
MEGA_PASSPHRASE=alpha docker compose run --rm cli admin diagnostics --server http://relay:8080
```

That is the complete Phase 1.1 build log and reproducibility guide.
