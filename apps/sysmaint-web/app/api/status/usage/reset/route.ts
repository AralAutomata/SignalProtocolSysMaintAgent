import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const { resetUsageTotals } = await import("@/lib/state-db");
    const resetAt = resetUsageTotals();
    return NextResponse.json({
      ok: true,
      resetAt
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
