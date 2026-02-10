import { z } from "zod";
import { NextResponse } from "next/server";
import { DemoUserSchema, pullDirectMessages } from "@/lib/e2ee-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  user: DemoUserSchema
});

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const parsed = QuerySchema.parse({
      user: url.searchParams.get("user")
    });
    const messages = await pullDirectMessages(parsed.user);
    return NextResponse.json({
      ok: true,
      user: parsed.user,
      messages
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

