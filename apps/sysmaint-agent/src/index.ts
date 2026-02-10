import { mkdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { ProtocolAddress } from "@signalapp/libsignal-client";
import {
  decodeSysmaintMessage,
  encodeSysmaintMessage,
  type HostMetrics,
  type RelaySnapshot,
  type SysmaintChatPrompt,
  type SysmaintTelemetryReport
} from "@mega/sysmaint-protocol";
import {
  decryptMessage,
  encryptMessage,
  exportBundle,
  generatePreKeys,
  initSession,
  initializeIdentity,
  loadEnvelope,
  openStore,
  type Bundle
} from "@mega/signal-core";
import { WebSocket, type RawData } from "ws";

const relayUrl = process.env.RELAY_URL ?? "http://relay:8080";
const signalDbPath = process.env.SYSMAINT_SIGNAL_DB ?? "/home/node/.mega/sysmaint.db";
const stateDbPath = process.env.SYSMAINT_STATE_DB ?? "/home/node/.mega/sysmaint-state.db";
const localId = process.env.SYSMAINT_ID ?? "sysmaint";
const modelName = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const openAiInputUsdPer1M = Number(process.env.OPENAI_INPUT_USD_PER_1M ?? "0.15");
const openAiOutputUsdPer1M = Number(process.env.OPENAI_OUTPUT_USD_PER_1M ?? "0.60");
const openAiApiKey = process.env.OPENAI_API_KEY;
const passphrase = process.env.MEGA_PASSPHRASE;

if (!passphrase) {
  throw new Error("MEGA_PASSPHRASE is required for sysmaint-agent.");
}
if (!openAiApiKey) {
  throw new Error("OPENAI_API_KEY is required for sysmaint-agent.");
}

const dbDir = path.dirname(signalDbPath);
mkdirSync(dbDir, { recursive: true });
mkdirSync(path.dirname(stateDbPath), { recursive: true });

const signalState = openStore(signalDbPath, passphrase);
const stateDb = new Database(stateDbPath);
stateDb.pragma("journal_mode = WAL");
stateDb.exec(
  "CREATE TABLE IF NOT EXISTS snapshots (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "report_id TEXT NOT NULL," +
    "source TEXT NOT NULL," +
    "created_at INTEGER NOT NULL," +
    "cpu_pct REAL NOT NULL," +
    "mem_pct REAL NOT NULL," +
    "swap_pct REAL NOT NULL," +
    "net_in_bytes REAL NOT NULL," +
    "net_out_bytes REAL NOT NULL," +
    "load1 REAL NOT NULL," +
    "load5 REAL NOT NULL," +
    "load15 REAL NOT NULL," +
    "relay_uptime_sec INTEGER NOT NULL," +
    "relay_users INTEGER NOT NULL," +
    "relay_prekeys INTEGER NOT NULL," +
    "relay_queued INTEGER NOT NULL," +
    "relay_active_ws INTEGER NOT NULL" +
    ");" +
    "CREATE TABLE IF NOT EXISTS chat_messages (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "request_id TEXT NOT NULL," +
    "direction TEXT NOT NULL," +
    "peer_id TEXT NOT NULL," +
    "content TEXT NOT NULL," +
    "created_at INTEGER NOT NULL," +
    "model_name TEXT," +
    "input_tokens INTEGER," +
    "output_tokens INTEGER," +
    "total_tokens INTEGER," +
    "estimated_cost_usd REAL" +
    ");" +
    "CREATE TABLE IF NOT EXISTS tool_calls (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "request_id TEXT NOT NULL," +
    "tool_name TEXT NOT NULL," +
    "args_json TEXT NOT NULL," +
    "result_json TEXT NOT NULL," +
    "created_at INTEGER NOT NULL" +
    ");"
);

type TableInfoRow = {
  name: string;
};

function ensureChatMessagesColumn(columnName: string, definition: string): void {
  const rows = stateDb.prepare("PRAGMA table_info(chat_messages)").all() as TableInfoRow[];
  const hasColumn = rows.some((row) => row.name === columnName);
  if (!hasColumn) {
    stateDb.exec(`ALTER TABLE chat_messages ADD COLUMN ${columnName} ${definition}`);
  }
}

ensureChatMessagesColumn("model_name", "TEXT");
ensureChatMessagesColumn("input_tokens", "INTEGER");
ensureChatMessagesColumn("output_tokens", "INTEGER");
ensureChatMessagesColumn("total_tokens", "INTEGER");
ensureChatMessagesColumn("estimated_cost_usd", "REAL");

const insertSnapshot = stateDb.prepare(
  "INSERT INTO snapshots (report_id, source, created_at, cpu_pct, mem_pct, swap_pct, net_in_bytes, net_out_bytes, load1, load5, load15, relay_uptime_sec, relay_users, relay_prekeys, relay_queued, relay_active_ws) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
);
const insertChat = stateDb.prepare(
  "INSERT INTO chat_messages (request_id, direction, peer_id, content, created_at, model_name, input_tokens, output_tokens, total_tokens, estimated_cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
);
const insertToolCall = stateDb.prepare(
  "INSERT INTO tool_calls (request_id, tool_name, args_json, result_json, created_at) VALUES (?, ?, ?, ?, ?)"
);
const latestSnapshotStmt = stateDb.prepare(
  "SELECT * FROM snapshots ORDER BY created_at DESC LIMIT 1"
);
const historySnapshotStmt = stateDb.prepare(
  "SELECT * FROM snapshots WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?"
);

const model = new ChatOpenAI({
  apiKey: openAiApiKey,
  model: modelName,
  temperature: 0.1
});

function resolveWsUrl(serverBase: string, clientId: string): string {
  const base = new URL(serverBase);
  const protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = new URL("/ws", `${protocol}//${base.host}`);
  wsUrl.searchParams.set("client_id", clientId);
  return wsUrl.toString();
}

async function httpGetJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return (await res.json()) as T;
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

function ensureBundle(input: unknown): Bundle {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid prekey bundle payload.");
  }
  const bundle = input as Bundle;
  if (!bundle.id) {
    throw new Error("Invalid prekey bundle payload.");
  }
  return bundle;
}

async function ensureIdentityBootstrapped(): Promise<void> {
  const existingLocal = signalState.getLocalIdentity();
  if (!existingLocal) {
    await initializeIdentity(signalState, localId, 1);
  }
  // Ensure there is always a fresh uploadable prekey bundle.
  await generatePreKeys(signalState, 1);

  await httpPostJson(`${relayUrl}/v1/register`, { id: localId });
  const bundle = await exportBundle(signalState);
  await httpPostJson(`${relayUrl}/v1/prekeys`, { id: localId, bundle });
}

async function ensureSessionWith(peerId: string): Promise<void> {
  const address = ProtocolAddress.new(peerId, 1);
  const existing = await signalState.sessionStore.getSession(address);
  if (existing) return;

  const payload = await httpGetJson<{ id: string; bundle: Bundle }>(`${relayUrl}/v1/prekeys/${peerId}`);
  await initSession(signalState, ensureBundle(payload.bundle));
}

function recordTelemetry(report: SysmaintTelemetryReport): void {
  insertSnapshot.run(
    report.reportId,
    report.source,
    report.createdAt,
    report.host.cpuPct,
    report.host.memPct,
    report.host.swapPct,
    report.host.netInBytes,
    report.host.netOutBytes,
    report.host.load[0],
    report.host.load[1],
    report.host.load[2],
    report.relay.uptimeSec,
    report.relay.counts.users,
    report.relay.counts.prekeys,
    report.relay.counts.queuedMessages,
    report.relay.counts.activeConnections
  );
}

function summarizeRelay(relay: RelaySnapshot): string {
  return `relay users=${relay.counts.users} prekeys=${relay.counts.prekeys} queued=${relay.counts.queuedMessages} active_ws=${relay.counts.activeConnections} uptime_sec=${relay.uptimeSec}`;
}

function summarizeHost(host: HostMetrics): string {
  return `host cpu=${host.cpuPct.toFixed(1)} mem=${host.memPct.toFixed(1)} swap=${host.swapPct.toFixed(1)} load=${host.load.map((v: number) => v.toFixed(2)).join("/")}`;
}

function toTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  return String(content ?? "");
}

type UsageStats = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
};

function toSafeNonNegativeNumber(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function pickFirstNumber(...values: unknown[]): number {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

function normalizeRatePer1M(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function estimateTokenCostUsd(inputTokens: number, outputTokens: number): number {
  const inputCost = (inputTokens / 1_000_000) * normalizeRatePer1M(openAiInputUsdPer1M);
  const outputCost = (outputTokens / 1_000_000) * normalizeRatePer1M(openAiOutputUsdPer1M);
  return Number((inputCost + outputCost).toFixed(8));
}

function extractUsageStats(message: AIMessage): UsageStats {
  const raw = message as unknown as {
    usage_metadata?: Record<string, unknown>;
    response_metadata?: Record<string, unknown>;
  };
  const usage = raw.usage_metadata ?? {};
  const responseMetadata = raw.response_metadata ?? {};
  const tokenUsage =
    responseMetadata && typeof responseMetadata.tokenUsage === "object" && responseMetadata.tokenUsage
      ? (responseMetadata.tokenUsage as Record<string, unknown>)
      : {};
  const responseUsage =
    responseMetadata && typeof responseMetadata.usage === "object" && responseMetadata.usage
      ? (responseMetadata.usage as Record<string, unknown>)
      : {};

  const inputTokens = pickFirstNumber(
    usage.input_tokens,
    usage.prompt_tokens,
    tokenUsage.promptTokens,
    tokenUsage.prompt_tokens,
    responseUsage.prompt_tokens,
    responseUsage.input_tokens
  );
  const outputTokens = pickFirstNumber(
    usage.output_tokens,
    usage.completion_tokens,
    tokenUsage.completionTokens,
    tokenUsage.completion_tokens,
    responseUsage.completion_tokens,
    responseUsage.output_tokens
  );
  const totalTokens = pickFirstNumber(
    usage.total_tokens,
    tokenUsage.totalTokens,
    tokenUsage.total_tokens,
    responseUsage.total_tokens,
    inputTokens + outputTokens
  );

  return {
    model: modelName,
    inputTokens: toSafeNonNegativeNumber(inputTokens),
    outputTokens: toSafeNonNegativeNumber(outputTokens),
    totalTokens: toSafeNonNegativeNumber(totalTokens || inputTokens + outputTokens),
    estimatedCostUsd: estimateTokenCostUsd(
      toSafeNonNegativeNumber(inputTokens),
      toSafeNonNegativeNumber(outputTokens)
    )
  };
}

type SnapshotRow = {
  created_at: number;
  cpu_pct: number;
  mem_pct: number;
  swap_pct: number;
  net_in_bytes: number;
  net_out_bytes: number;
  load1: number;
  load5: number;
  load15: number;
  relay_users: number;
  relay_prekeys: number;
  relay_queued: number;
  relay_active_ws: number;
};

async function generateAssistantReply(
  requestId: string,
  prompt: SysmaintChatPrompt
): Promise<{ replyText: string; usage: UsageStats }> {
  const getCurrentStatusTool = new DynamicStructuredTool({
    name: "get_current_status",
    description: "Returns the most recent system status snapshot for SysMaint.",
    schema: z.object({}),
    func: async () => {
      const row = latestSnapshotStmt.get() as SnapshotRow | undefined;
      const result =
        row === undefined
          ? { ok: false, message: "No telemetry snapshots stored yet." }
          : {
              ok: true,
              snapshot: {
                createdAt: row.created_at,
                cpuPct: row.cpu_pct,
                memPct: row.mem_pct,
                swapPct: row.swap_pct,
                netInBytes: row.net_in_bytes,
                netOutBytes: row.net_out_bytes,
                load: [row.load1, row.load5, row.load15],
                relay: {
                  users: row.relay_users,
                  prekeys: row.relay_prekeys,
                  queuedMessages: row.relay_queued,
                  activeConnections: row.relay_active_ws
                }
              }
            };
      insertToolCall.run(requestId, "get_current_status", "{}", JSON.stringify(result), Date.now());
      return JSON.stringify(result);
    }
  });

  const getRecentHistoryTool = new DynamicStructuredTool({
    name: "get_recent_status_history",
    description: "Returns recent telemetry snapshots for trend summaries.",
    schema: z.object({ minutes: z.number().int().min(1).max(720).default(30) }),
    func: async ({ minutes }) => {
      const since = Date.now() - minutes * 60_000;
      const rows = historySnapshotStmt.all(since, 30) as SnapshotRow[];
      const result = {
        ok: true,
        count: rows.length,
        minutes,
        rows: rows.map((row) => ({
          createdAt: row.created_at,
          cpuPct: row.cpu_pct,
          memPct: row.mem_pct,
          relayQueued: row.relay_queued,
          activeConnections: row.relay_active_ws
        }))
      };
      insertToolCall.run(
        requestId,
        "get_recent_status_history",
        JSON.stringify({ minutes }),
        JSON.stringify(result),
        Date.now()
      );
      return JSON.stringify(result);
    }
  });

  const getAnomalySummaryTool = new DynamicStructuredTool({
    name: "get_anomaly_summary",
    description: "Returns simple anomaly signals from the latest snapshot.",
    schema: z.object({}),
    func: async () => {
      const row = latestSnapshotStmt.get() as SnapshotRow | undefined;
      const issues: string[] = [];
      if (!row) {
        issues.push("No data available yet.");
      } else {
        if (row.cpu_pct >= 85) issues.push(`High CPU (${row.cpu_pct.toFixed(1)}%).`);
        if (row.mem_pct >= 90) issues.push(`High memory (${row.mem_pct.toFixed(1)}%).`);
        if (row.relay_queued >= 10) issues.push(`Relay queue depth elevated (${row.relay_queued}).`);
      }
      const result = {
        ok: true,
        healthy: issues.length === 0,
        issues
      };
      insertToolCall.run(requestId, "get_anomaly_summary", "{}", JSON.stringify(result), Date.now());
      return JSON.stringify(result);
    }
  });

  const tools: DynamicStructuredTool[] = [getCurrentStatusTool, getRecentHistoryTool, getAnomalySummaryTool];
  const toolByName = new Map<string, DynamicStructuredTool>(tools.map((tool) => [tool.name, tool]));

  const systemPrompt = [
    "You are SysMaint, a production-minded systems operator assistant for a local relay + Signal messaging stack.",
    `Current UTC time: ${new Date().toISOString()}.`,
    "",
    "Operating priorities:",
    "1) Accuracy over fluency. Never invent metrics or tool results.",
    "2) Fast triage. Lead with health status, then evidence, then next action.",
    "3) Practical advice. Suggest commands/actions the operator can run locally.",
    "",
    "Tool policy:",
    "- For any question about current system health/status, call get_current_status first.",
    "- For trend/time-window questions, call get_recent_status_history with an appropriate minutes window.",
    "- For risk/incident questions, call get_anomaly_summary.",
    "- If data appears stale or missing, say so explicitly and explain what data is missing.",
    "",
    "Response style:",
    "- Keep responses concise and operator-friendly.",
    "- Include explicit numbers and timestamps when available.",
    "- If healthy: state healthy + one or two key metrics.",
    "- If unhealthy: state severity (low/medium/high), likely cause, and immediate next steps.",
    "",
    "Preferred output templates:",
    "A) Status requests:",
    "Health: <healthy|degraded|critical>",
    "Signals: <cpu/mem/queue/active connections + timestamp>",
    "Action: <single best next step>",
    "",
    "B) Incident/anomaly requests:",
    "Severity: <low|medium|high>",
    "What triggered it: <specific metric condition>",
    "Immediate checks: <1-3 concrete checks>",
    "",
    "If user asks a general question without metrics context, answer briefly and still anchor to available telemetry when useful."
  ].join("\\n");

  const llmWithTools = model.bindTools(tools);
  const messages = [new SystemMessage(systemPrompt), new HumanMessage(prompt.prompt)];

  let response = await llmWithTools.invoke(messages);

  for (let step = 0; step < 5; step += 1) {
    const toolCalls = response.tool_calls ?? [];
    if (toolCalls.length === 0) {
      break;
    }

    messages.push(response);

    for (const toolCall of toolCalls) {
      const tool = toolByName.get(toolCall.name);
      if (!tool) continue;

      const result = await tool.invoke((toolCall.args ?? {}) as Record<string, unknown>);
      messages.push(
        new ToolMessage({
          tool_call_id: toolCall.id ?? `${toolCall.name}:${Date.now()}`,
          content: typeof result === "string" ? result : JSON.stringify(result)
        })
      );
    }

    response = await llmWithTools.invoke(messages);
  }

  const finalResponse = response as AIMessage;
  return {
    replyText: toTextContent(finalResponse.content) || "No reply generated.",
    usage: extractUsageStats(finalResponse)
  };
}

async function handleMessage(data: RawData): Promise<void> {
  const payload = JSON.parse(data.toString()) as { envelope?: unknown };
  const envelope = loadEnvelope(payload.envelope ?? payload);
  const plaintext = await decryptMessage(signalState, envelope);
  const message = decodeSysmaintMessage(plaintext);

  if (message.kind === "telemetry.report") {
    recordTelemetry(message);
    console.log(
      `[telemetry] ${message.source} ${summarizeRelay(message.relay)} ${summarizeHost(message.host)}`
    );
    return;
  }

  if (message.kind === "chat.prompt") {
    const peerId = envelope.senderId;
    insertChat.run(message.requestId, "in", peerId, message.prompt, Date.now(), null, null, null, null, null);

    const generated = await generateAssistantReply(message.requestId, message);
    insertChat.run(
      message.requestId,
      "out",
      peerId,
      generated.replyText,
      Date.now(),
      generated.usage.model,
      generated.usage.inputTokens,
      generated.usage.outputTokens,
      generated.usage.totalTokens,
      generated.usage.estimatedCostUsd
    );

    await ensureSessionWith(peerId);
    const replyPayload = {
      version: 1,
      kind: "chat.reply",
      requestId: message.requestId,
      reply: generated.replyText,
      from: localId,
      createdAt: Date.now()
    } as const;
    const outbound = await encryptMessage(signalState, peerId, encodeSysmaintMessage(replyPayload));

    await httpPostJson(`${relayUrl}/v1/messages`, {
      from: localId,
      to: peerId,
      envelope: outbound
    });
    console.log(
      `[chat] replied to ${peerId} request=${message.requestId} tokens=${generated.usage.totalTokens} cost_usd=${generated.usage.estimatedCostUsd.toFixed(6)}`
    );
    return;
  }

  if (message.kind === "chat.reply") {
    // SysMaint should not normally receive replies, but we keep logs if it does.
    insertChat.run(message.requestId, "in", envelope.senderId, message.reply, Date.now(), null, null, null, null, null);
  }
}

let shouldStop = false;
let activeWs: WebSocket | null = null;

process.on("SIGINT", () => {
  shouldStop = true;
  activeWs?.close(1000, "SIGINT");
});
process.on("SIGTERM", () => {
  shouldStop = true;
  activeWs?.close(1000, "SIGTERM");
});

async function listenLoop(): Promise<void> {
  while (!shouldStop) {
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(resolveWsUrl(relayUrl, localId));
      activeWs = ws;

      ws.on("open", () => {
        console.log(`sysmaint-agent listening on ${resolveWsUrl(relayUrl, localId)}`);
      });

      ws.on("message", (data) => {
        void handleMessage(data).catch((err) => {
          console.error("message handler error", err);
        });
      });

      ws.on("close", () => {
        activeWs = null;
        resolve();
      });

      ws.on("error", (err) => {
        console.error("websocket error", err);
      });
    });

    if (!shouldStop) {
      await delay(1000);
    }
  }
}

async function main(): Promise<void> {
  await ensureIdentityBootstrapped();
  console.log(`sysmaint-agent started with id=${localId} relay=${relayUrl}`);
  await listenLoop();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
