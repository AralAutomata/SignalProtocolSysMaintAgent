import path from "node:path";

const defaultDataDir = path.join(process.cwd(), ".sysmaint");

export const relayUrl = process.env.RELAY_URL ?? "http://relay:8080";
export const aliceId = process.env.ALICE_ID ?? "alice";
export const bobId = process.env.BOB_ID ?? "bob";
export const sysmaintId = process.env.SYSMAINT_ID ?? "sysmaint";
export const signalDbPath = process.env.SYSMAINT_WEB_SIGNAL_DB ?? path.join(defaultDataDir, "alice-web.db");
export const bobSignalDbPath = process.env.BOB_SIGNAL_DB ?? path.join(defaultDataDir, "bob-web.db");
export const stateDbPath = process.env.SYSMAINT_STATE_DB ?? path.join(defaultDataDir, "sysmaint-state.db");
export const waitTimeoutMs = Number(process.env.SYSMAINT_CHAT_TIMEOUT_MS ?? "25000");
