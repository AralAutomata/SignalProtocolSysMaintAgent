import { z } from "zod";
import { NextResponse } from "next/server";
import { DemoUserSchema, sendDirectMessage } from "@/lib/e2ee-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  from: DemoUserSchema,
  to: DemoUserSchema,
  text: z.string().min(1)
});

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    const message = await sendDirectMessage(body.from, body.to, body.text);
    return NextResponse.json({
      ok: true,
      message
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

