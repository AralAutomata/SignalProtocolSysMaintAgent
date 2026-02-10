import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { stateDbPath } from "./config";

export type StatusSnapshot = {
  createdAt: number;
  cpuPct: number;
  memPct: number;
  swapPct: number;
  netInBytes: number;
  netOutBytes: number;
  load: [number, number, number];
  relay: {
    users: number;
    prekeys: number;
    queuedMessages: number;
    activeConnections: number;
    uptimeSec: number;
  };
};

export type UsageTotals = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  averageTokensPerReply: number;
  lastReplyAt: number | null;
};

mkdirSync(path.dirname(stateDbPath), { recursive: true });
const db = new Database(stateDbPath, { readonly: false });

db.exec(
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
    "CREATE TABLE IF NOT EXISTS usage_resets (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "created_at INTEGER NOT NULL" +
    ");"
);

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
  relay_uptime_sec: number;
  relay_users: number;
  relay_prekeys: number;
  relay_queued: number;
  relay_active_ws: number;
};

type TableInfoRow = {
  name: string;
};

type UsageRow = {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
  last_reply_at: number | null;
};

type UsageResetRow = {
  created_at: number | null;
};

function mapRow(row: SnapshotRow): StatusSnapshot {
  return {
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
      activeConnections: row.relay_active_ws,
      uptimeSec: row.relay_uptime_sec
    }
  };
}

export function getLatestSnapshot(): StatusSnapshot | null {
  const row = db
    .prepare(
      "SELECT created_at, cpu_pct, mem_pct, swap_pct, net_in_bytes, net_out_bytes, load1, load5, load15, relay_uptime_sec, relay_users, relay_prekeys, relay_queued, relay_active_ws FROM snapshots ORDER BY created_at DESC LIMIT 1"
    )
    .get() as SnapshotRow | undefined;

  if (!row) return null;
  return mapRow(row);
}

export function getRecentSnapshots(minutes: number, limit = 120): StatusSnapshot[] {
  const since = Date.now() - minutes * 60_000;
  const rows = db
    .prepare(
      "SELECT created_at, cpu_pct, mem_pct, swap_pct, net_in_bytes, net_out_bytes, load1, load5, load15, relay_uptime_sec, relay_users, relay_prekeys, relay_queued, relay_active_ws FROM snapshots WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(since, limit) as SnapshotRow[];
  return rows.map(mapRow);
}

function hasChatUsageColumns(): boolean {
  const rows = db.prepare("PRAGMA table_info(chat_messages)").all() as TableInfoRow[];
  if (rows.length === 0) return false;
  const names = new Set(rows.map((row) => row.name));
  return (
    names.has("input_tokens") &&
    names.has("output_tokens") &&
    names.has("total_tokens") &&
    names.has("estimated_cost_usd")
  );
}

function getUsageWindowStart(): number {
  const row = db.prepare("SELECT MAX(created_at) AS created_at FROM usage_resets").get() as UsageResetRow | undefined;
  return row?.created_at ? Number(row.created_at) : 0;
}

export function resetUsageTotals(at = Date.now()): number {
  db.prepare("INSERT INTO usage_resets (created_at) VALUES (?)").run(at);
  return at;
}

export function getUsageTotals(): UsageTotals {
  if (!hasChatUsageColumns()) {
    return {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      averageTokensPerReply: 0,
      lastReplyAt: null
    };
  }

  const startAt = getUsageWindowStart();
  const row = db
    .prepare(
      "SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(total_tokens), 0) AS total_tokens, COALESCE(SUM(estimated_cost_usd), 0) AS estimated_cost_usd, MAX(created_at) AS last_reply_at FROM chat_messages WHERE direction = 'out' AND created_at > ?"
    )
    .get(startAt) as UsageRow | undefined;

  if (!row) {
    return {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      averageTokensPerReply: 0,
      lastReplyAt: null
    };
  }

  const requests = Number(row.requests) || 0;
  const totalTokens = Number(row.total_tokens) || 0;
  return {
    requests,
    inputTokens: Number(row.input_tokens) || 0,
    outputTokens: Number(row.output_tokens) || 0,
    totalTokens,
    estimatedCostUsd: Number((Number(row.estimated_cost_usd) || 0).toFixed(8)),
    averageTokensPerReply: requests > 0 ? Number((totalTokens / requests).toFixed(1)) : 0,
    lastReplyAt: row.last_reply_at ? Number(row.last_reply_at) : null
  };
}
