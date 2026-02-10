import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { ProtocolAddress } from "@signalapp/libsignal-client";
import {
  encodeSysmaintMessage,
  type HostMetrics,
  type RelaySnapshot,
  type SysmaintTelemetryReport
} from "@mega/sysmaint-protocol";
import {
  encryptMessage,
  exportBundle,
  generatePreKeys,
  initSession,
  initializeIdentity,
  openStore,
  type Bundle
} from "@mega/signal-core";

const relayUrl = process.env.RELAY_URL ?? "http://relay:8080";
const intervalMs = Number(process.env.SYSMAINT_PROBE_INTERVAL_MS ?? "10000");
const localId = process.env.DIAG_PROBE_ID ?? "diagprobe";
const targetId = process.env.SYSMAINT_ID ?? "sysmaint";
const signalDbPath = process.env.DIAG_PROBE_SIGNAL_DB ?? "/home/node/.mega/diagprobe.db";
const passphrase = process.env.MEGA_PASSPHRASE;

if (!passphrase) {
  throw new Error("MEGA_PASSPHRASE is required for diag-probe.");
}

mkdirSync(path.dirname(signalDbPath), { recursive: true });
const signalState = openStore(signalDbPath, passphrase);

let lastCpuSample: { idle: number; total: number } | null = null;

function parseCpuStat(text: string): { idle: number; total: number } {
  const line = text.split("\n")[0] ?? "";
  const parts = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((part) => Number(part));
  const total = parts.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
  return { idle, total };
}

function computeCpuPct(prev: { idle: number; total: number }, next: { idle: number; total: number }): number {
  const idleDelta = next.idle - prev.idle;
  const totalDelta = next.total - prev.total;
  if (totalDelta <= 0) return 0;
  return ((totalDelta - idleDelta) / totalDelta) * 100;
}

function parseMeminfo(text: string): { memPct: number; swapPct: number } {
  const values = new Map<string, number>();
  for (const line of text.split("\n")) {
    const [key, rest] = line.split(":");
    if (!key || !rest) continue;
    const first = Number(rest.trim().split(/\s+/)[0]);
    values.set(key, Number.isFinite(first) ? first : 0);
  }
  const memTotal = values.get("MemTotal") ?? 0;
  const memAvail = values.get("MemAvailable") ?? 0;
  const swapTotal = values.get("SwapTotal") ?? 0;
  const swapFree = values.get("SwapFree") ?? 0;

  const memPct = memTotal > 0 ? ((memTotal - memAvail) / memTotal) * 100 : 0;
  const swapPct = swapTotal > 0 ? ((swapTotal - swapFree) / swapTotal) * 100 : 0;
  return { memPct, swapPct };
}

function parseNetDev(text: string): { netInBytes: number; netOutBytes: number } {
  const lines = text.trim().split("\n").slice(2);
  let rxTotal = 0;
  let txTotal = 0;

  for (const line of lines) {
    const parts = line.trim().split(/[:\s]+/);
    const iface = parts[0];
    if (!iface || iface === "lo") continue;
    const rx = Number(parts[1] ?? 0);
    const tx = Number(parts[9] ?? 0);
    rxTotal += Number.isFinite(rx) ? rx : 0;
    txTotal += Number.isFinite(tx) ? tx : 0;
  }

  return { netInBytes: rxTotal, netOutBytes: txTotal };
}

async function sampleHostMetrics(): Promise<HostMetrics> {
  const [cpuStat, meminfo, netdev] = await Promise.all([
    readFile("/proc/stat", "utf8"),
    readFile("/proc/meminfo", "utf8"),
    readFile("/proc/net/dev", "utf8")
  ]);

  const nowCpu = parseCpuStat(cpuStat);
  let cpuPct = 0;
  if (lastCpuSample) {
    cpuPct = computeCpuPct(lastCpuSample, nowCpu);
  } else {
    const load = os.loadavg()[0] ?? 0;
    cpuPct = (load / Math.max(os.cpus().length, 1)) * 100;
  }
  lastCpuSample = nowCpu;

  const mem = parseMeminfo(meminfo);
  const net = parseNetDev(netdev);

  return {
    cpuPct,
    memPct: mem.memPct,
    swapPct: mem.swapPct,
    netInBytes: net.netInBytes,
    netOutBytes: net.netOutBytes,
    load: [os.loadavg()[0] ?? 0, os.loadavg()[1] ?? 0, os.loadavg()[2] ?? 0]
  };
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
  if (!signalState.getLocalIdentity()) {
    await initializeIdentity(signalState, localId, 1);
  }
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

async function fetchRelaySnapshot(): Promise<RelaySnapshot> {
  const payload = await httpGetJson<{
    uptimeSec: number;
    queueDepthHistogram: Record<string, number>;
    counts: {
      users: number;
      prekeys: number;
      queuedMessages: number;
      activeConnections: number;
    };
  }>(`${relayUrl}/diagnostics`);

  return {
    uptimeSec: payload.uptimeSec,
    queueDepthHistogram: payload.queueDepthHistogram,
    counts: payload.counts
  };
}

async function publishTelemetry(): Promise<void> {
  await ensureSessionWith(targetId);

  const [host, relay] = await Promise.all([sampleHostMetrics(), fetchRelaySnapshot()]);
  const report: SysmaintTelemetryReport = {
    version: 1,
    kind: "telemetry.report",
    reportId: randomUUID(),
    source: localId,
    relay,
    host,
    createdAt: Date.now()
  };

  const envelope = await encryptMessage(signalState, targetId, encodeSysmaintMessage(report));
  await httpPostJson(`${relayUrl}/v1/messages`, {
    from: localId,
    to: targetId,
    envelope
  });

  console.log(
    `[probe] sent telemetry report=${report.reportId} cpu=${report.host.cpuPct.toFixed(1)} mem=${report.host.memPct.toFixed(1)} queued=${report.relay.counts.queuedMessages}`
  );
}

async function main(): Promise<void> {
  await ensureIdentityBootstrapped();
  console.log(`diag-probe started id=${localId} -> ${targetId} relay=${relayUrl} interval=${intervalMs}ms`);

  while (true) {
    try {
      await publishTelemetry();
    } catch (err) {
      console.error("[probe] telemetry error", err);
    }
    await delay(intervalMs);
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
