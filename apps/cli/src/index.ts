import { Command, CommanderError } from "commander";
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import os from "node:os";
import { WebSocket, type RawData } from "ws";
import { ProtocolAddress } from "@signalapp/libsignal-client";
import {
  decryptMessage,
  encryptMessage,
  exportBundle,
  generatePreKeys,
  initSession,
  initializeIdentity,
  loadEnvelope,
  listInboxMessages,
  openStore,
  saveInboxMessage,
  type Bundle,
  type InboxMessage
} from "@mega/signal-core";

const program = new Command();
program
  .name("mega")
  .description("Minimal Signal Protocol CLI (phase zero)")
  .option("--db <path>", "Path to local SQLite DB")
  .option("--passphrase <passphrase>", "Passphrase for local DB encryption")
  .option("--server <url>", "Relay server base URL", "http://localhost:8080");

program.exitOverride();

function defaultDbPath(): string {
  return path.join(os.homedir(), ".mega", "mega.db");
}

function resolveDbPath(opts: { db?: string }): string {
  return opts.db ?? defaultDbPath();
}

function ensureDbDir(dbPath: string): void {
  const dir = path.dirname(dbPath);
  mkdirSync(dir, { recursive: true });
}

async function promptPassphrase(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const passphrase = await rl.question("Passphrase (input visible): ");
  rl.close();
  if (!passphrase) throw new Error("Passphrase required.");
  return passphrase;
}

async function resolvePassphrase(opts: { passphrase?: string }): Promise<string> {
  if (opts.passphrase) return opts.passphrase;
  if (process.env.MEGA_PASSPHRASE) return process.env.MEGA_PASSPHRASE;
  return await promptPassphrase();
}

async function readText(source?: string): Promise<string> {
  if (!source || source === "-") {
    return await new Promise((resolve, reject) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", reject);
    });
  }
  return await readFile(source, "utf8");
}

async function writeText(target: string | undefined, text: string): Promise<void> {
  if (!target || target === "-") {
    process.stdout.write(text);
    return;
  }
  await writeFile(target, text, "utf8");
}

async function readJson<T>(source: string): Promise<T> {
  const content = await readText(source);
  return JSON.parse(content) as T;
}

function resolveServerUrl(opts: { server?: string }): string {
  return opts.server ?? "http://localhost:8080";
}

function resolveWsUrl(serverBase: string, clientId: string, wsOverride?: string): string {
  if (wsOverride) return wsOverride;
  const base = new URL(serverBase);
  const wsProtocol = base.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = new URL("/ws", `${wsProtocol}//${base.host}`);
  wsUrl.searchParams.set("client_id", clientId);
  return wsUrl.toString();
}

async function httpPostJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return (await res.json()) as T;
}

async function httpGetJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return (await res.json()) as T;
}

function ensureBundle(input: unknown): Bundle {
  if (!input || typeof input !== "object") throw new Error("Invalid bundle payload.");
  const bundle = input as Bundle;
  if (!bundle.id) throw new Error("Invalid bundle payload.");
  return bundle;
}

program
  .command("init")
  .description("Initialize local identity and storage")
  .requiredOption("--id <id>", "Local identity id")
  .option("--device <id>", "Device id", "1")
  .action(async (cmdOpts) => {
    const opts = program.opts();
    const dbPath = resolveDbPath(opts);
    ensureDbDir(dbPath);
    const passphrase = await resolvePassphrase(opts);

    const state = openStore(dbPath, passphrase);
    await initializeIdentity(state, cmdOpts.id, Number(cmdOpts.device));
    await generatePreKeys(state, 1);

    console.log(`Initialized identity '${cmdOpts.id}' in ${dbPath}`);
  });

program
  .command("identity")
  .description("Identity operations")
  .command("show")
  .description("Show local identity info")
  .action(async () => {
    const opts = program.opts();
    const dbPath = resolveDbPath(opts);
    const passphrase = await resolvePassphrase(opts);
    const state = openStore(dbPath, passphrase);
    console.log(
      JSON.stringify(
        {
          id: state.getLocalIdentity(),
          registrationId: state.getRegistrationId(),
          deviceId: state.getDeviceId()
        },
        null,
        2
      )
    );
  });

program
  .command("prekey")
  .description("Prekey operations")
  .command("generate")
  .description("Generate new prekeys")
  .option("--count <n>", "Number of prekeys", "1")
  .action(async (cmdOpts) => {
    const opts = program.opts();
    const dbPath = resolveDbPath(opts);
    const passphrase = await resolvePassphrase(opts);
    const state = openStore(dbPath, passphrase);
    await generatePreKeys(state, Number(cmdOpts.count));
    console.log(`Generated ${cmdOpts.count} prekeys.`);
  });

program
  .command("bundle")
  .description("Bundle operations")
  .command("export")
  .description("Export local bundle")
  .requiredOption("--out <file>", "Output file")
  .action(async (cmdOpts) => {
    const opts = program.opts();
    const dbPath = resolveDbPath(opts);
    const passphrase = await resolvePassphrase(opts);
    const state = openStore(dbPath, passphrase);

    const bundle = await exportBundle(state);
    await writeText(cmdOpts.out, JSON.stringify(bundle, null, 2));
    console.log(`Bundle exported to ${cmdOpts.out}`);
  });

program
  .command("session")
  .description("Session operations")
  .command("init")
  .description("Initialize a session from a peer bundle")
  .requiredOption("--their-bundle <file>", "Path to peer bundle JSON")
  .action(async (cmdOpts) => {
    const opts = program.opts();
    const dbPath = resolveDbPath(opts);
    const passphrase = await resolvePassphrase(opts);
    const state = openStore(dbPath, passphrase);

    const bundle = await readJson<Bundle>(cmdOpts.theirBundle);
    await initSession(state, bundle);
    console.log(`Session initialized with ${bundle.id}`);
  });

program
  .command("encrypt")
  .description("Encrypt a message")
  .requiredOption("--to <id>", "Recipient id")
  .option("--in <file>", "Input file (default: stdin)")
  .option("--out <file>", "Output file (default: stdout)")
  .action(async (cmdOpts) => {
    const opts = program.opts();
    const dbPath = resolveDbPath(opts);
    const passphrase = await resolvePassphrase(opts);
    const state = openStore(dbPath, passphrase);

    const plaintext = await readText(cmdOpts.in);
    const envelope = await encryptMessage(state, cmdOpts.to, plaintext);
    await writeText(cmdOpts.out, JSON.stringify(envelope, null, 2));
  });

program
  .command("decrypt")
  .description("Decrypt a message envelope")
  .option("--in <file>", "Input file (default: stdin)")
  .option("--out <file>", "Output file (default: stdout)")
  .action(async (cmdOpts) => {
    const opts = program.opts();
    const dbPath = resolveDbPath(opts);
    const passphrase = await resolvePassphrase(opts);
    const state = openStore(dbPath, passphrase);

    const payload = await readJson(cmdOpts.in ?? "-");
    const envelope = loadEnvelope(payload);
    const plaintext = await decryptMessage(state, envelope);
    await writeText(cmdOpts.out, plaintext);
  });

const client = program.command("client").description("Relay server client operations");

client
  .command("register")
  .description("Register a local identity with the relay server")
  .requiredOption("--id <id>", "Local identity id")
  .action(async (cmdOpts) => {
    const opts = program.opts();
    const server = resolveServerUrl(opts);
    await httpPostJson(`${server}/v1/register`, { id: cmdOpts.id });
    console.log(`Registered ${cmdOpts.id} at ${server}`);
  });

const clientPrekeys = client.command("prekeys").description("Prekey operations via relay server");

clientPrekeys
  .command("upload")
  .description("Upload local prekey bundle to relay server")
  .action(async () => {
    const opts = program.opts();
    const server = resolveServerUrl(opts);
    const dbPath = resolveDbPath(opts);
    const passphrase = await resolvePassphrase(opts);
    const state = openStore(dbPath, passphrase);
    const bundle = await exportBundle(state);
    await httpPostJson(`${server}/v1/prekeys`, { id: bundle.id, bundle });
    console.log(`Uploaded prekeys for ${bundle.id} to ${server}`);
  });

clientPrekeys
  .command("fetch")
  .description("Fetch a peer prekey bundle from relay server")
  .requiredOption("--id <id>", "Peer identity id")
  .option("--out <file>", "Output file (default: stdout)")
  .action(async (cmdOpts) => {
    const opts = program.opts();
    const server = resolveServerUrl(opts);
    const payload = await httpGetJson<{ id: string; bundle: Bundle }>(`${server}/v1/prekeys/${cmdOpts.id}`);
    await writeText(cmdOpts.out, JSON.stringify(payload.bundle, null, 2));
    console.log(`Fetched prekeys for ${payload.id} from ${server}`);
  });

client
  .command("send")
  .description("Encrypt and send a message via relay server")
  .requiredOption("--to <id>", "Recipient id")
  .option("--in <file>", "Input file (default: stdin)")
  .action(async (cmdOpts) => {
    const opts = program.opts();
    const server = resolveServerUrl(opts);
    const dbPath = resolveDbPath(opts);
    const passphrase = await resolvePassphrase(opts);
    const state = openStore(dbPath, passphrase);

    const localId = state.getLocalIdentity();
    if (!localId) throw new Error("Local identity not set. Run 'mega init'.");

    const address = ProtocolAddress.new(cmdOpts.to, 1);
    const existing = await state.sessionStore.getSession(address);
    if (!existing) {
      const payload = await httpGetJson<{ id: string; bundle: Bundle }>(`${server}/v1/prekeys/${cmdOpts.to}`);
      const bundle = ensureBundle(payload.bundle);
      await initSession(state, bundle);
    }

    const plaintext = await readText(cmdOpts.in);
    const envelope = await encryptMessage(state, cmdOpts.to, plaintext);
    await httpPostJson(`${server}/v1/messages`, { from: localId, to: cmdOpts.to, envelope });
    console.log(`Sent message from ${localId} to ${cmdOpts.to} via ${server}`);
  });

client
  .command("listen")
  .description("Listen for incoming messages via relay server WebSocket")
  .requiredOption("--id <id>", "Local identity id")
  .option("--ws <url>", "WebSocket URL (default: derived from --server)")
  .action(async (cmdOpts) => {
    const opts = program.opts();
    const server = resolveServerUrl(opts);
    const wsUrl = resolveWsUrl(server, cmdOpts.id, cmdOpts.ws);
    const dbPath = resolveDbPath(opts);
    const passphrase = await resolvePassphrase(opts);
    const state = openStore(dbPath, passphrase);

    const ws = new WebSocket(wsUrl);
    let exiting = false;
    let exitCode = 0;
    let forceExitTimer: NodeJS.Timeout | undefined;

    const clearForceExitTimer = (): void => {
      if (!forceExitTimer) return;
      clearTimeout(forceExitTimer);
      forceExitTimer = undefined;
    };

    const cleanupSignalHandlers = (): void => {
      process.off("SIGINT", handleSigint);
      process.off("SIGTERM", handleSigterm);
    };

    const exitNow = (code: number): never => {
      clearForceExitTimer();
      cleanupSignalHandlers();
      process.exit(code);
    };

    const beginShutdown = (code: number, reason: string): void => {
      if (exiting) return;
      exiting = true;
      exitCode = code;

      const isSocketActive = ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING;
      if (!isSocketActive) {
        exitNow(code);
      }

      forceExitTimer = setTimeout(() => {
        console.error("Forcing listener shutdown.");
        exitNow(exitCode);
      }, 1500);
      forceExitTimer.unref();

      try {
        ws.close(code === 0 ? 1000 : 1011, reason);
      } catch {
        exitNow(code);
      }
    };

    const handleSigint = (): void => {
      console.log("Received SIGINT, shutting down listener...");
      beginShutdown(0, "SIGINT");
    };

    const handleSigterm = (): void => {
      console.log("Received SIGTERM, shutting down listener...");
      beginShutdown(0, "SIGTERM");
    };

    process.once("SIGINT", handleSigint);
    process.once("SIGTERM", handleSigterm);

    ws.on("open", () => {
      console.log(`Listening for messages on ${wsUrl}`);
    });
    ws.on("message", async (data: RawData) => {
      try {
        const payload = JSON.parse(data.toString()) as { envelope?: unknown; from?: string };
        const envelope = loadEnvelope(payload.envelope ?? payload);
        const plaintext = await decryptMessage(state, envelope);
        const inboxMessage: InboxMessage = {
          id: `${envelope.timestamp}:${envelope.senderId}:${Math.random().toString(36).slice(2)}`,
          senderId: envelope.senderId,
          timestamp: envelope.timestamp,
          plaintext,
          envelope
        };
        saveInboxMessage(state, inboxMessage);
        console.log(`[${envelope.senderId}] ${plaintext}`);
      } catch (err) {
        console.error(err);
      }
    });
    ws.on("close", () => {
      console.log("WebSocket closed.");
      exitNow(exitCode);
    });
    ws.on("error", (err: Error) => {
      console.error(err);
      beginShutdown(1, "socket-error");
    });
  });

client
  .command("inbox")
  .description("List decrypted inbox messages stored locally")
  .option("--limit <n>", "Max messages to show (default: 20)", "20")
  .option("--since <epoch>", "Only show messages after this epoch ms")
  .option("--json", "Output as JSON")
  .action(async (cmdOpts) => {
    const opts = program.opts();
    const dbPath = resolveDbPath(opts);
    const passphrase = await resolvePassphrase(opts);
    const state = openStore(dbPath, passphrase);

    const limit = Number(cmdOpts.limit ?? 20);
    const since = cmdOpts.since ? Number(cmdOpts.since) : undefined;

    let messages = listInboxMessages(state);
    if (Number.isFinite(since)) {
      messages = messages.filter((msg) => msg.timestamp > (since ?? 0));
    }
    if (Number.isFinite(limit)) {
      messages = messages.slice(-limit);
    }

    if (cmdOpts.json) {
      console.log(JSON.stringify(messages, null, 2));
      return;
    }

    if (messages.length === 0) {
      console.log("Inbox empty.");
      return;
    }

    for (const msg of messages) {
      const ts = formatTimestamp(msg.timestamp);
      console.log(`[${ts}] ${msg.senderId}: ${msg.plaintext}`);
    }
  });

const admin = program.command("admin").description("Relay diagnostics (privacy-safe)");

admin
  .command("diagnostics")
  .description("Fetch relay diagnostics snapshot")
  .option("--json", "Output raw JSON")
  .action(async (cmdOpts) => {
    const opts = program.opts();
    const server = resolveServerUrl(opts);
    const payload = await httpGetJson<{
      uptimeSec: number;
      dbPath: string;
      counts: {
        users: number;
        prekeys: number;
        queuedMessages: number;
        activeConnections: number;
      };
      queueDepthHistogram: Record<string, number>;
      metrics: {
        cpuPct: number;
        memPct: number;
        swapPct: number;
        netInBytes: number;
        netOutBytes: number;
        load: [number, number, number];
        updatedAt: number;
      } | null;
    }>(`${server}/diagnostics`);

    if (cmdOpts.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`Uptime: ${formatDuration(payload.uptimeSec)}`);
    console.log(`DB: ${payload.dbPath}`);
    console.log(
      `Counts: users=${payload.counts.users} prekeys=${payload.counts.prekeys} queued=${payload.counts.queuedMessages} active_ws=${payload.counts.activeConnections}`
    );
    const hist = payload.queueDepthHistogram;
    console.log(
      `Queue histogram: 0=${hist["0"] ?? 0} 1-5=${hist["1-5"] ?? 0} 6-20=${hist["6-20"] ?? 0} 21+=${hist["21+"] ?? 0}`
    );
    if (payload.metrics) {
      console.log(
        `Metrics: cpu=${payload.metrics.cpuPct.toFixed(1)}% mem=${payload.metrics.memPct.toFixed(1)}% swap=${payload.metrics.swapPct.toFixed(1)}% net_in=${payload.metrics.netInBytes} net_out=${payload.metrics.netOutBytes}`
      );
      console.log(
        `Load: ${payload.metrics.load.map((v) => v.toFixed(2)).join(" ")} updated_at=${formatTimestamp(payload.metrics.updatedAt)}`
      );
    } else {
      console.log("Metrics: none (diagnostics worker not running)");
    }
  });

program
  .command("repl")
  .description("Start interactive REPL")
  .action(async () => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log("Mega REPL. Type 'help' or 'exit'.");
    while (true) {
      const line = await rl.question("> ");
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === "exit" || trimmed === "quit") break;
      if (trimmed === "help") {
        console.log("Commands: init, identity show, prekey generate, bundle export, session init, encrypt, decrypt");
        continue;
      }
      const args = trimmed.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
      const cleaned = args.map((arg) => arg.replace(/^"|"$/g, ""));
      try {
        await program.parseAsync(["node", "mega", ...cleaned], { from: "user" });
      } catch (err) {
        if (err instanceof CommanderError) {
          console.error(err.message);
        } else {
          console.error(err);
        }
      }
    }
    rl.close();
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.code === "commander.helpDisplayed") return;
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

void main();
function formatTimestamp(epoch: number): string {
  return new Date(epoch).toISOString();
}

function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hrs}h ${mins}m ${secs}s`;
}
