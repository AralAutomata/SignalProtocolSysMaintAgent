import { mkdirSync } from "node:fs";
import path from "node:path";
import { ProtocolAddress } from "@signalapp/libsignal-client";
import { WebSocket, type RawData } from "ws";
import {
  createRequestId,
  decodeSysmaintMessage,
  encodeSysmaintMessage,
  type SysmaintChatPrompt
} from "@mega/sysmaint-protocol";
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
import { aliceId, relayUrl, signalDbPath, sysmaintId, waitTimeoutMs } from "./config";

let signalState: ReturnType<typeof openStore> | null = null;
let chatPromptQueue: Promise<void> = Promise.resolve();

function getPassphrase(): string {
  const value = process.env.MEGA_PASSPHRASE;
  if (!value) {
    throw new Error("MEGA_PASSPHRASE is required for sysmaint-web API.");
  }
  return value;
}

function getSignalState() {
  if (signalState) return signalState;
  mkdirSync(path.dirname(signalDbPath), { recursive: true });
  signalState = openStore(signalDbPath, getPassphrase());
  return signalState;
}

export function getAliceSignalState() {
  return getSignalState();
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

export async function ensureAliceBootstrapped(): Promise<void> {
  const state = getSignalState();
  if (!state.getLocalIdentity()) {
    await initializeIdentity(state, aliceId, 1);
  }

  await generatePreKeys(state, 1);
  await httpPostJson(`${relayUrl}/v1/register`, { id: aliceId });

  const bundle = await exportBundle(state);
  await httpPostJson(`${relayUrl}/v1/prekeys`, { id: aliceId, bundle });
}

export async function ensureAliceSessionWith(peerId: string): Promise<void> {
  const state = getSignalState();
  const address = ProtocolAddress.new(peerId, 1);
  const existing = await state.sessionStore.getSession(address);
  if (existing) return;

  const payload = await httpGetJson<{ id: string; bundle: Bundle }>(`${relayUrl}/v1/prekeys/${peerId}`);
  await initSession(state, ensureBundle(payload.bundle));
}

async function waitForChatReply(requestId: string, timeoutMs: number): Promise<string> {
  const state = getSignalState();
  return await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(resolveWsUrl(relayUrl, aliceId));
    let settled = false;

    const done = (fn: (value: string | Error) => void, value: string | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      try {
        ws.close(1000, "done");
      } catch {
        // ignore close errors
      }
      fn(value);
    };

    const timeoutHandle = setTimeout(() => {
      done((err) => reject(err), new Error(`Timed out waiting for SysMaint reply (requestId=${requestId}).`));
    }, timeoutMs);
    timeoutHandle.unref();

    ws.on("message", (raw: RawData) => {
      void (async () => {
        try {
          const payload = JSON.parse(raw.toString()) as { envelope?: unknown };
          const envelope = loadEnvelope(payload.envelope ?? payload);
          const plaintext = await decryptMessage(state, envelope);
          const message = decodeSysmaintMessage(plaintext);
          if (message.kind !== "chat.reply") return;
          if (message.requestId !== requestId) return;
          done((text) => resolve(String(text)), message.reply);
        } catch {
          // Ignore invalid/unrelated frames while we wait for the matching request.
        }
      })().catch((err) => {
        done((error) => reject(error), err as Error);
      });
    });

    ws.on("error", (err) => {
      done((error) => reject(error), err as Error);
    });

    ws.on("close", () => {
      if (!settled) {
        done((error) => reject(error), new Error("WebSocket closed before reply arrived."));
      }
    });
  });
}

function runChatPromptSerial<T>(task: () => Promise<T>): Promise<T> {
  const run = chatPromptQueue.then(task, task);
  chatPromptQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export async function sendPromptToSysmaint(prompt: string): Promise<{ requestId: string; reply: string }> {
  return await runChatPromptSerial(async () => {
    const state = getSignalState();
    await ensureAliceBootstrapped();
    await ensureAliceSessionWith(sysmaintId);

    const requestId = createRequestId();
    const message: SysmaintChatPrompt = {
      version: 1,
      kind: "chat.prompt",
      requestId,
      prompt,
      from: aliceId,
      createdAt: Date.now()
    };

    const envelope = await encryptMessage(state, sysmaintId, encodeSysmaintMessage(message));
    await httpPostJson(`${relayUrl}/v1/messages`, {
      from: aliceId,
      to: sysmaintId,
      envelope
    });

    const reply = await waitForChatReply(requestId, waitTimeoutMs);
    return { requestId, reply };
  });
}
