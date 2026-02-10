import { z } from "zod";

export const EnvelopeSchema = z.object({
  version: z.number().int().positive(),
  senderId: z.string().min(1),
  recipientId: z.string().min(1),
  sessionId: z.string().min(1),
  type: z.number().int().nonnegative(),
  body: z.string().min(1),
  timestamp: z.number().int().positive()
});

export type Envelope = z.infer<typeof EnvelopeSchema>;

export function parseEnvelope(input: unknown): Envelope {
  return EnvelopeSchema.parse(input);
}
