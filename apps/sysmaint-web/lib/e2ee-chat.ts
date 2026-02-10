import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProtocolAddress } from "@signalapp/libsignal-client";
import { WebSocket, type RawData } from "ws";
import {
  decryptMessage,
  encryptMessage,
  exportBundle,
  generatePreKeys,
  initSession,
  initializeIdentity,
  loadEnvelope,
  openStore,
  type Bundle
} from "@mega/signal-core";
import { aliceId, bobId, bobSignalDbPath, relayUrl } from "./config";
import { ensureAliceBootstrapped, ensureAliceSessionWith, getAliceSignalState } from "./signal";

export const DemoUserSchema = z.enum(["alice", "bob"]);
export type DemoUser = z.infer<typeof DemoUserSchema>;

export const DirectUserChatSchema = z.object({
  version: z.literal(1),
  kind: z.literal("user.chat.v1"),
  messageId: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  text: z.string().min(1),
  createdAt: z.number().int().positive()
});

export type DirectUserChat = z.infer<typeof DirectUserChatSchema>;

type SignalState = ReturnType<typeof openStore>;

const userIdByKey: Record<DemoUser, string> = {
  alice: aliceId,
  bob: bobId
};

let bobState: SignalState | null = null;

function getPassphrase(): string {
  const value = process.env.MEGA_PASSPHRASE;
  if (!value) {
    throw new Error("MEGA_PASSPHRASE is required for direct E2EE chat.");
  }
  return value;
}

function getState(user: DemoUser): SignalState {
  if (user === "alice") return getAliceSignalState();
  if (bobState) return bobState;
  mkdirSync(path.dirname(bobSignalDbPath), { recursive: true });
  bobState = openStore(bobSignalDbPath, getPassphrase());
  return bobState;
}

function resolveWsUrl(serverBase: string, clientId: string): string {
  const base = new URL(serverBase);
  const protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = new URL("/ws", `${protocol}//${base.host}`);
  wsUrl.searchParams.set("client_id", clientId);
  return wsUrl.toString();
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

async function ensureUserBootstrapped(user: DemoUser): Promise<void> {
  if (user === "alice") {
    await ensureAliceBootstrapped();
    return;
  }

  const state = getState(user);
  const userId = userIdByKey[user];

  if (!state.getLocalIdentity()) {
    await initializeIdentity(state, userId, 1);
  }

  await generatePreKeys(state, 1);
  await httpPostJson(`${relayUrl}/v1/register`, { id: userId });
  const bundle = await exportBundle(state);
  await httpPostJson(`${relayUrl}/v1/prekeys`, { id: userId, bundle });
}

async function ensureSessionWith(from: DemoUser, peerId: string): Promise<void> {
  if (from === "alice") {
    await ensureAliceSessionWith(peerId);
    return;
  }

  const state = getState(from);
  const address = ProtocolAddress.new(peerId, 1);
  const existing = await state.sessionStore.getSession(address);
  if (existing) return;

  const payload = await httpGetJson<{ id: string; bundle: Bundle }>(`${relayUrl}/v1/prekeys/${peerId}`);
  await initSession(state, ensureBundle(payload.bundle));
}

export async function sendDirectMessage(from: DemoUser, to: DemoUser, text: string): Promise<DirectUserChat> {
  if (from === to) {
    throw new Error("Sender and recipient must be different.");
  }

  const fromId = userIdByKey[from];
  const toId = userIdByKey[to];
  const state = getState(from);

  await ensureUserBootstrapped(from);
  await ensureUserBootstrapped(to);
  await ensureSessionWith(from, toId);

  const message: DirectUserChat = {
    version: 1,
    kind: "user.chat.v1",
    messageId: randomUUID(),
    from: fromId,
    to: toId,
    text,
    createdAt: Date.now()
  };

  const envelope = await encryptMessage(state, toId, JSON.stringify(message));
  await httpPostJson(`${relayUrl}/v1/messages`, {
    from: fromId,
    to: toId,
    envelope
  });

  return message;
}

export async function pullDirectMessages(user: DemoUser, windowMs = 900): Promise<DirectUserChat[]> {
  const userId = userIdByKey[user];
  const state = getState(user);

  await ensureUserBootstrapped(user);

  return await new Promise<DirectUserChat[]>((resolve, reject) => {
    const ws = new WebSocket(resolveWsUrl(relayUrl, userId));
    const received = new Map<string, DirectUserChat>();
    const pending: Promise<void>[] = [];
    let settled = false;

    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void Promise.allSettled(pending).then(() => {
        try {
          ws.close(1000, "pull-complete");
        } catch {
          // ignore
        }
        if (err) reject(err);
        else resolve(Array.from(received.values()).sort((a, b) => a.createdAt - b.createdAt));
      });
    };

    const timer = setTimeout(() => done(), windowMs);
    timer.unref();

    ws.on("message", (raw: RawData) => {
      const task = (async () => {
        try {
          const payload = JSON.parse(raw.toString()) as { envelope?: unknown };
          const envelope = loadEnvelope(payload.envelope ?? payload);
          const plaintext = await decryptMessage(state, envelope);
          const parsed = DirectUserChatSchema.safeParse(JSON.parse(plaintext));
          if (!parsed.success) return;
          if (parsed.data.to !== userId) return;
          received.set(parsed.data.messageId, parsed.data);
        } catch {
          // Ignore unrelated payloads or parse failures.
        }
      })();
      pending.push(task);
    });

    ws.on("error", (err) => {
      done(err instanceof Error ? err : new Error(String(err)));
    });

    ws.on("close", () => {
      done();
    });
  });
}
