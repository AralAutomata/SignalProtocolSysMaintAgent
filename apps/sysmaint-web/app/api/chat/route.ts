import { z } from "zod";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const BodySchema = z.object({
  prompt: z.string().min(1)
});

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    const { sendPromptToSysmaint } = await import("@/lib/signal");
    const result = await sendPromptToSysmaint(body.prompt);
    return NextResponse.json({
      ok: true,
      requestId: result.requestId,
      reply: result.reply,
      respondedAt: Date.now()
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
