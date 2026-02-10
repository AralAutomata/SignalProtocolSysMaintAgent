import http from "node:http";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { EnvelopeSchema } from "@mega/shared";

const RegisterSchema = z.object({
  id: z.string().min(1)
});

const BundleSchema = z.object({
  id: z.string().min(1),
  deviceId: z.number().int().positive(),
  registrationId: z.number().int().positive(),
  identityKey: z.string().min(1),
  signedPreKey: z.object({
    keyId: z.number().int().nonnegative(),
    publicKey: z.string().min(1),
    signature: z.string().min(1)
  }),
  preKey: z.object({
    keyId: z.number().int().nonnegative(),
    publicKey: z.string().min(1)
  }),
  kyberPreKey: z.object({
    keyId: z.number().int().nonnegative(),
    publicKey: z.string().min(1),
    signature: z.string().min(1)
  })
});

const PreKeyUploadSchema = z.object({
  id: z.string().min(1),
  bundle: BundleSchema
});

const MessageSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  envelope: EnvelopeSchema
});

type Bundle = z.infer<typeof BundleSchema>;
type Envelope = z.infer<typeof EnvelopeSchema>;

type MessageRow = {
  id: string;
  to_id: string;
  from_id: string;
  envelope_json: string;
  created_at: number;
};

type DiagnosticsMetrics = {
  cpuPct: number;
  memPct: number;
  swapPct: number;
  netInBytes: number;
  netOutBytes: number;
  load: [number, number, number];
  updatedAt: number;
};

function resolveDbPath(): string {
  const envPath = process.env.RELAY_DB;
  if (envPath) return envPath;
  return path.join(process.cwd(), "data", "relay.db");
}

function ensureDbDir(dbPath: string): void {
  const dir = path.dirname(dbPath);
  mkdirSync(dir, { recursive: true });
}

function openDb(dbPath: string): InstanceType<typeof Database> {
  ensureDbDir(dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS prekeys (id TEXT PRIMARY KEY, bundle_json TEXT NOT NULL, updated_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, to_id TEXT NOT NULL, from_id TEXT NOT NULL, envelope_json TEXT NOT NULL, created_at INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);"
  );
  return db;
}

function json<T>(res: http.ServerResponse, status: number, payload: T): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function text(res: http.ServerResponse, status: number, payload: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

function normalizeServerUrl(reqUrl: string | undefined): URL {
  return new URL(reqUrl ?? "/", "http://localhost");
}

async function sendWsMessage(ws: WebSocket, payload: unknown): Promise<void> {
  return await new Promise((resolve, reject) => {
    ws.send(JSON.stringify(payload), (err?: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function buildMessagePayload(row: MessageRow): { from: string; to: string; envelope: Envelope } {
  return {
    from: row.from_id,
    to: row.to_id,
    envelope: JSON.parse(row.envelope_json) as Envelope
  };
}

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  const port = Number(process.env.RELAY_PORT ?? process.env.PORT ?? "8080");
  const host = process.env.RELAY_HOST ?? "0.0.0.0";

  const db = openDb(dbPath);

  const stmtUserInsert = db.prepare("INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)");
  const stmtUserExists = db.prepare("SELECT 1 FROM users WHERE id = ?");
  const stmtPrekeyUpsert = db.prepare(
    "INSERT OR REPLACE INTO prekeys (id, bundle_json, updated_at) VALUES (?, ?, ?)"
  );
  const stmtPrekeyGet = db.prepare("SELECT bundle_json FROM prekeys WHERE id = ?");
  const stmtMsgInsert = db.prepare(
    "INSERT INTO messages (id, to_id, from_id, envelope_json, created_at, delivered) VALUES (?, ?, ?, ?, ?, 0)"
  );
  const stmtMsgPending = db.prepare(
    "SELECT id, to_id, from_id, envelope_json, created_at FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY created_at ASC"
  );
  const stmtMsgMarkDelivered = db.prepare("UPDATE messages SET delivered = 1 WHERE id = ?");
  const stmtUserCount = db.prepare("SELECT COUNT(1) as count FROM users");
  const stmtPrekeyCount = db.prepare("SELECT COUNT(1) as count FROM prekeys");
  const stmtQueuedCount = db.prepare("SELECT COUNT(1) as count FROM messages WHERE delivered = 0");
  const stmtQueueByRecipient = db.prepare(
    "SELECT to_id, COUNT(1) as count FROM messages WHERE delivered = 0 GROUP BY to_id"
  );

  const connections = new Map<string, WebSocket>();
  const startedAt = Date.now();
  let latestMetrics: DiagnosticsMetrics | null = null;

  async function deliverPending(toId: string, ws: WebSocket): Promise<void> {
    const rows = stmtMsgPending.all(toId) as MessageRow[];
    for (const row of rows) {
      try {
        await sendWsMessage(ws, buildMessagePayload(row));
        stmtMsgMarkDelivered.run(row.id);
      } catch {
        break;
      }
    }
  }

  async function deliverIfConnected(row: MessageRow): Promise<boolean> {
    const ws = connections.get(row.to_id);
    if (!ws || ws.readyState !== ws.OPEN) return false;
    try {
      await sendWsMessage(ws, buildMessagePayload(row));
      stmtMsgMarkDelivered.run(row.id);
      return true;
    } catch {
      return false;
    }
  }

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws: WebSocket, _request: http.IncomingMessage, clientId: string) => {
    const existing = connections.get(clientId);
    if (existing && existing !== ws) {
      existing.close(4000, "superseded");
    }
    connections.set(clientId, ws);
    void deliverPending(clientId, ws);

    ws.on("close", () => {
      if (connections.get(clientId) === ws) connections.delete(clientId);
    });

    ws.on("error", () => {
      if (connections.get(clientId) === ws) connections.delete(clientId);
    });
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = normalizeServerUrl(req.url);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        return text(res, 200, "ok");
      }

      if (method === "GET" && url.pathname === "/diagnostics") {
        const users = (stmtUserCount.get() as { count: number }).count;
        const prekeys = (stmtPrekeyCount.get() as { count: number }).count;
        const queued = (stmtQueuedCount.get() as { count: number }).count;
        const byRecipient = stmtQueueByRecipient.all() as { to_id: string; count: number }[];

        const histogram = { "0": 0, "1-5": 0, "6-20": 0, "21+": 0 };
        for (const row of byRecipient) {
          if (row.count <= 0) histogram["0"] += 1;
          else if (row.count <= 5) histogram["1-5"] += 1;
          else if (row.count <= 20) histogram["6-20"] += 1;
          else histogram["21+"] += 1;
        }

        return json(res, 200, {
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          dbPath,
          counts: {
            users,
            prekeys,
            queuedMessages: queued,
            activeConnections: connections.size
          },
          queueDepthHistogram: histogram,
          metrics: latestMetrics
        });
      }

      if (method === "POST" && url.pathname === "/diagnostics/metrics") {
        const payload = await readJson(req);
        const schema = z.object({
          cpuPct: z.number().min(0),
          memPct: z.number().min(0),
          swapPct: z.number().min(0),
          netInBytes: z.number().min(0),
          netOutBytes: z.number().min(0),
          load: z.tuple([z.number(), z.number(), z.number()]),
          updatedAt: z.number().int().positive()
        });
        latestMetrics = schema.parse(payload);
        return json(res, 200, { ok: true });
      }

      if (method === "POST" && url.pathname === "/v1/register") {
        const payload = RegisterSchema.parse(await readJson(req));
        stmtUserInsert.run(payload.id, Date.now());
        return json(res, 200, { id: payload.id });
      }

      if (method === "POST" && url.pathname === "/v1/prekeys") {
        const payload = PreKeyUploadSchema.parse(await readJson(req));
        const user = stmtUserExists.get(payload.id);
        if (!user) return json(res, 404, { error: "User not registered." });
        stmtPrekeyUpsert.run(payload.id, JSON.stringify(payload.bundle), Date.now());
        return json(res, 200, { ok: true });
      }

      if (method === "GET" && url.pathname.startsWith("/v1/prekeys/")) {
        const id = decodeURIComponent(url.pathname.replace("/v1/prekeys/", ""));
        const row = stmtPrekeyGet.get(id) as { bundle_json: string } | undefined;
        if (!row) return json(res, 404, { error: "Prekeys not found." });
        return json(res, 200, { id, bundle: JSON.parse(row.bundle_json) as Bundle });
      }

      if (method === "POST" && url.pathname === "/v1/messages") {
        const payload = MessageSchema.parse(await readJson(req));
        const user = stmtUserExists.get(payload.to);
        if (!user) return json(res, 404, { error: "Recipient not registered." });

        const messageId = randomUUID();
        const createdAt = Date.now();
        const envelopeJson = JSON.stringify(payload.envelope);
        stmtMsgInsert.run(messageId, payload.to, payload.from, envelopeJson, createdAt);

        const delivered = await deliverIfConnected({
          id: messageId,
          to_id: payload.to,
          from_id: payload.from,
          envelope_json: envelopeJson,
          created_at: createdAt
        });

        return json(res, 200, { ok: true, queued: true, delivered });
      }

      return json(res, 404, { error: "Not found." });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return json(res, 400, { error: "Invalid request.", details: err.flatten() });
      }
      if (err instanceof Error && err.message === "Invalid JSON body.") {
        return json(res, 400, { error: "Invalid JSON body." });
      }
      console.error(err);
      return json(res, 500, { error: "Internal server error." });
    }
  });

  server.on("upgrade", (req, socket, head) => {
    try {
      const url = normalizeServerUrl(req.url);
      if (url.pathname !== "/ws") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      const clientId = url.searchParams.get("client_id");
      if (!clientId) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }

      const user = stmtUserExists.get(clientId);
      if (!user) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        wss.emit("connection", ws, req, clientId);
      });
    } catch {
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      socket.destroy();
    }
  });

  server.listen(port, host, () => {
    console.log(`Relay server listening on http://${host}:${port}`);
    console.log(`SQLite DB at ${dbPath}`);
  });

  process.on("SIGINT", () => {
    server.close();
    wss.close();
    db.close();
    process.exit(0);
  });
}

void main();
