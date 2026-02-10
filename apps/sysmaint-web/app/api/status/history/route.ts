import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { getRecentSnapshots } = await import("@/lib/state-db");
  const url = new URL(req.url);
  const minutes = Number(url.searchParams.get("minutes") ?? "60");
  const limit = Number(url.searchParams.get("limit") ?? "120");
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 60;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 120;

  return NextResponse.json({
    ok: true,
    minutes: safeMinutes,
    limit: safeLimit,
    snapshots: getRecentSnapshots(safeMinutes, safeLimit)
  });
}
