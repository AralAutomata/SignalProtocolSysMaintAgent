import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const { getLatestSnapshot, getUsageTotals } = await import("@/lib/state-db");
  const snapshot = getLatestSnapshot();
  const usage = getUsageTotals();
  return NextResponse.json({
    ok: true,
    snapshot,
    usage,
    staleSeconds: snapshot ? Math.max(0, Math.floor((Date.now() - snapshot.createdAt) / 1000)) : null
  });
}
