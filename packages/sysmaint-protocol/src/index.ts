import { randomUUID } from "node:crypto";
import { z } from "zod";

export const RelayCountsSchema = z.object({
  users: z.number().int().nonnegative(),
  prekeys: z.number().int().nonnegative(),
  queuedMessages: z.number().int().nonnegative(),
  activeConnections: z.number().int().nonnegative()
});

export const RelaySnapshotSchema = z.object({
  uptimeSec: z.number().int().nonnegative(),
  queueDepthHistogram: z.record(z.number().int().nonnegative()),
  counts: RelayCountsSchema
});

export const HostMetricsSchema = z.object({
  cpuPct: z.number().min(0),
  memPct: z.number().min(0),
  swapPct: z.number().min(0),
  netInBytes: z.number().nonnegative(),
  netOutBytes: z.number().nonnegative(),
  load: z.tuple([z.number(), z.number(), z.number()])
});

export const SysmaintChatPromptSchema = z.object({
  version: z.literal(1),
  kind: z.literal("chat.prompt"),
  requestId: z.string().min(1),
  prompt: z.string().min(1),
  from: z.string().min(1),
  createdAt: z.number().int().positive()
});

export const SysmaintChatReplySchema = z.object({
  version: z.literal(1),
  kind: z.literal("chat.reply"),
  requestId: z.string().min(1),
  reply: z.string().min(1),
  from: z.string().min(1),
  createdAt: z.number().int().positive()
});

export const SysmaintTelemetryReportSchema = z.object({
  version: z.literal(1),
  kind: z.literal("telemetry.report"),
  reportId: z.string().min(1),
  source: z.string().min(1),
  relay: RelaySnapshotSchema,
  host: HostMetricsSchema,
  createdAt: z.number().int().positive()
});

export const SysmaintControlSchema = z.object({
  version: z.literal(1),
  kind: z.literal("control.ping"),
  createdAt: z.number().int().positive()
});

export const SysmaintMessageSchema = z.discriminatedUnion("kind", [
  SysmaintChatPromptSchema,
  SysmaintChatReplySchema,
  SysmaintTelemetryReportSchema,
  SysmaintControlSchema
]);

export type RelaySnapshot = z.infer<typeof RelaySnapshotSchema>;
export type HostMetrics = z.infer<typeof HostMetricsSchema>;
export type SysmaintChatPrompt = z.infer<typeof SysmaintChatPromptSchema>;
export type SysmaintChatReply = z.infer<typeof SysmaintChatReplySchema>;
export type SysmaintTelemetryReport = z.infer<typeof SysmaintTelemetryReportSchema>;
export type SysmaintMessage = z.infer<typeof SysmaintMessageSchema>;

export function createRequestId(): string {
  return randomUUID();
}

export function encodeSysmaintMessage(message: SysmaintMessage): string {
  return JSON.stringify(message);
}

export function decodeSysmaintMessage(raw: string): SysmaintMessage {
  return SysmaintMessageSchema.parse(JSON.parse(raw));
}
