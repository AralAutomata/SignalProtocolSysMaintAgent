"use client";

import { useEffect, useState } from "react";

type StatusPayload = {
  ok: boolean;
  staleSeconds: number | null;
  usage: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    averageTokensPerReply: number;
    lastReplyAt: number | null;
  };
  snapshot: {
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
  } | null;
};

function fmtTs(ts: number): string {
  return new Date(ts).toLocaleString();
}

function fmtNum(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function fmtUsd(value: number): string {
  return `$${value.toFixed(6)}`;
}

export default function DashboardPage() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetInfo, setResetInfo] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;

    const load = async () => {
      try {
        const res = await fetch("/api/status/current", { cache: "no-store" });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const payload = (await res.json()) as StatusPayload;
        if (!stop) {
          setData(payload);
          setError(null);
        }
      } catch (err) {
        if (!stop) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };

    void load();
    const timer = setInterval(() => {
      void load();
    }, 5000);

    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);

  const onResetUsage = async () => {
    if (resetBusy) return;
    setResetBusy(true);
    setResetInfo(null);
    try {
      const resetRes = await fetch("/api/status/usage/reset", {
        method: "POST",
        cache: "no-store"
      });
      if (!resetRes.ok) {
        throw new Error(`HTTP ${resetRes.status}`);
      }
      const resetPayload = (await resetRes.json()) as { ok: boolean; resetAt?: number; error?: string };
      if (!resetPayload.ok || !resetPayload.resetAt) {
        throw new Error(resetPayload.error ?? "Failed to reset usage totals.");
      }

      const statusRes = await fetch("/api/status/current", { cache: "no-store" });
      if (!statusRes.ok) {
        throw new Error(`HTTP ${statusRes.status}`);
      }
      const statusPayload = (await statusRes.json()) as StatusPayload;
      setData(statusPayload);
      setError(null);
      setResetInfo(`Token usage reset at ${fmtTs(resetPayload.resetAt)}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResetBusy(false);
    }
  };

  const snapshot = data?.snapshot;
  const usage = data?.usage;

  return (
    <section>
      <h1>System Status Dashboard</h1>
      <p className="sub">Encrypted telemetry from Signal messages (Alice/SysMaint stack).</p>
      {error ? <p className="sub">Error: {error}</p> : null}
      {resetInfo ? <p className="sub">{resetInfo}</p> : null}
      {!snapshot ? (
        <div className="card">
          <div className="label">Status</div>
          <div className="value">No snapshots yet</div>
          <div className="sub">Start `diag-probe` and `sysmaint-agent` to populate telemetry.</div>
        </div>
      ) : (
        <>
          <div className="grid">
            <div className="card">
              <div className="label">CPU</div>
              <div className="value">{snapshot.cpuPct.toFixed(1)}%</div>
            </div>
            <div className="card">
              <div className="label">Memory</div>
              <div className="value">{snapshot.memPct.toFixed(1)}%</div>
            </div>
            <div className="card">
              <div className="label">Swap</div>
              <div className="value">{snapshot.swapPct.toFixed(1)}%</div>
            </div>
            <div className="card">
              <div className="label">Queue</div>
              <div className="value">{snapshot.relay.queuedMessages}</div>
            </div>
          </div>
          <div className="grid" style={{ marginTop: 12 }}>
            <div className="card">
              <div className="label">Relay Users</div>
              <div className="value">{snapshot.relay.users}</div>
              <div className="sub">Prekeys: {snapshot.relay.prekeys}</div>
            </div>
            <div className="card">
              <div className="label">Active WebSockets</div>
              <div className="value">{snapshot.relay.activeConnections}</div>
              <div className="sub">Uptime: {snapshot.relay.uptimeSec}s</div>
            </div>
            <div className="card">
              <div className="label">Load Average</div>
              <div className="value">
                {snapshot.load.map((v) => v.toFixed(2)).join(" / ")}
              </div>
            </div>
            <div className="card">
              <div className="label">Last Update</div>
              <div className="value" style={{ fontSize: 16 }}>{fmtTs(snapshot.createdAt)}</div>
              <div className="sub">Staleness: {data?.staleSeconds ?? "?"}s</div>
            </div>
          </div>
          <div className="grid" style={{ marginTop: 12 }}>
            <div className="card">
              <div className="label">LLM Requests</div>
              <div className="value">{fmtNum(usage?.requests ?? 0)}</div>
              <div className="sub">
                Last reply: {usage?.lastReplyAt ? fmtTs(usage.lastReplyAt) : "n/a"}
              </div>
              <div style={{ marginTop: 10 }}>
                <button type="button" onClick={onResetUsage} disabled={resetBusy}>
                  {resetBusy ? "Resetting..." : "Reset Token Usage"}
                </button>
              </div>
            </div>
            <div className="card">
              <div className="label">Input Tokens</div>
              <div className="value">{fmtNum(usage?.inputTokens ?? 0)}</div>
              <div className="sub">Output: {fmtNum(usage?.outputTokens ?? 0)}</div>
            </div>
            <div className="card">
              <div className="label">Total Tokens</div>
              <div className="value">{fmtNum(usage?.totalTokens ?? 0)}</div>
              <div className="sub">Avg/reply: {fmtNum(Math.round(usage?.averageTokensPerReply ?? 0))}</div>
            </div>
            <div className="card">
              <div className="label">Estimated Spend</div>
              <div className="value">{fmtUsd(usage?.estimatedCostUsd ?? 0)}</div>
              <div className="sub">Based on configured model token rates</div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
