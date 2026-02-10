import Database from "better-sqlite3";
import {
  Direction,
  IdentityChange,
  IdentityKeyPair,
  IdentityKeyStore,
  KyberPreKeyRecord,
  KyberPreKeyStore,
  PreKeyRecord,
  PreKeyStore,
  ProtocolAddress,
  PublicKey,
  SessionRecord,
  SessionStore,
  SignedPreKeyRecord,
  SignedPreKeyStore,
  PrivateKey
} from "@signalapp/libsignal-client";
import { createKdfParams, decryptJson, deriveKey, encryptJson, type KdfParams } from "./crypto.js";

const META_KDF = "kdf";
const META_LOCAL_ID = "localId";
const META_DEVICE_ID = "deviceId";
const META_REG_ID = "registrationId";

export class EncryptedStore {
  private db: InstanceType<typeof Database>;
  private key: Buffer;

  constructor(dbPath: string, passphrase: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value BLOB NOT NULL);"
    );

    const kdf = this.getMeta<KdfParams>(META_KDF);
    const params = kdf ?? createKdfParams();
    if (!kdf) {
      this.setMeta(META_KDF, params);
    }
    this.key = deriveKey(passphrase, params);
  }

  getMeta<T>(key: string): T | undefined {
    const stmt = this.db.prepare("SELECT value FROM meta WHERE key = ?");
    const row = stmt.get(key) as { value: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.value) as T;
  }

  setMeta<T>(key: string, value: T): void {
    const stmt = this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
    stmt.run(key, JSON.stringify(value));
  }

  get<T>(key: string): T | undefined {
    const stmt = this.db.prepare("SELECT value FROM kv WHERE key = ?");
    const row = stmt.get(key) as { value: Buffer } | undefined;
    if (!row) return undefined;
    return decryptJson(this.key, row.value) as T;
  }

  set(key: string, value: unknown): void {
    const payload = encryptJson(this.key, value);
    const stmt = this.db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)");
    stmt.run(key, payload);
  }

  delete(key: string): void {
    const stmt = this.db.prepare("DELETE FROM kv WHERE key = ?");
    stmt.run(key);
  }

  listKeysByPrefix(prefix: string): string[] {
    const stmt = this.db.prepare("SELECT key FROM kv WHERE key LIKE ?");
    const rows = stmt.all(`${prefix}%`) as { key: string }[];
    return rows.map((row) => row.key);
  }

  getLocalId(): string | undefined {
    return this.getMeta<string>(META_LOCAL_ID);
  }

  setLocalId(id: string): void {
    this.setMeta(META_LOCAL_ID, id);
  }

  getDeviceId(): number | undefined {
    return this.getMeta<number>(META_DEVICE_ID);
  }

  setDeviceId(id: number): void {
    this.setMeta(META_DEVICE_ID, id);
  }

  getRegistrationId(): number | undefined {
    return this.getMeta<number>(META_REG_ID);
  }

  setRegistrationId(id: number): void {
    this.setMeta(META_REG_ID, id);
  }
}

function addressKey(address: ProtocolAddress): string {
  return address.toString();
}

export class SqliteIdentityStore extends IdentityKeyStore {
  constructor(private store: EncryptedStore) {
    super();
  }

  async getIdentityKey(): Promise<PrivateKey> {
    const data = this.store.get<Uint8Array>("local:identityKeyPair");
    if (!data) throw new Error("Identity key pair not found. Run 'mega init'.");
    return IdentityKeyPair.deserialize(data).privateKey;
  }

  async getLocalRegistrationId(): Promise<number> {
    const value = this.store.getRegistrationId();
    if (value === undefined) throw new Error("Registration id not found. Run 'mega init'.");
    return value;
  }

  async saveIdentity(name: ProtocolAddress, key: PublicKey): Promise<IdentityChange> {
    const stored = this.store.get<Uint8Array>(`identity:${addressKey(name)}`);
    const serialized = key.serialize();
    this.store.set(`identity:${addressKey(name)}`, serialized);
    if (!stored) return IdentityChange.NewOrUnchanged;
    const existing = PublicKey.deserialize(stored);
    return existing.equals(key) ? IdentityChange.NewOrUnchanged : IdentityChange.ReplacedExisting;
  }

  async isTrustedIdentity(name: ProtocolAddress, key: PublicKey, _direction: Direction): Promise<boolean> {
    const stored = this.store.get<Uint8Array>(`identity:${addressKey(name)}`);
    if (!stored) return true;
    const existing = PublicKey.deserialize(stored);
    return existing.equals(key);
  }

  async getIdentity(name: ProtocolAddress): Promise<PublicKey | null> {
    const stored = this.store.get<Uint8Array>(`identity:${addressKey(name)}`);
    if (!stored) return null;
    return PublicKey.deserialize(stored);
  }
}

export class SqliteSessionStore extends SessionStore {
  constructor(private store: EncryptedStore) {
    super();
  }

  async saveSession(name: ProtocolAddress, record: SessionRecord): Promise<void> {
    this.store.set(`session:${addressKey(name)}`, record.serialize());
  }

  async getSession(name: ProtocolAddress): Promise<SessionRecord | null> {
    const stored = this.store.get<Uint8Array>(`session:${addressKey(name)}`);
    if (!stored) return null;
    return SessionRecord.deserialize(stored);
  }

  async getExistingSessions(addresses: ProtocolAddress[]): Promise<SessionRecord[]> {
    const records: SessionRecord[] = [];
    for (const address of addresses) {
      const record = await this.getSession(address);
      if (record) records.push(record);
    }
    return records;
  }
}

export class SqlitePreKeyStore extends PreKeyStore {
  constructor(private store: EncryptedStore) {
    super();
  }

  async savePreKey(id: number, record: PreKeyRecord): Promise<void> {
    this.store.set(`prekey:${id}`, record.serialize());
  }

  async getPreKey(id: number): Promise<PreKeyRecord> {
    const stored = this.store.get<Uint8Array>(`prekey:${id}`);
    if (!stored) throw new Error(`PreKey ${id} not found`);
    return PreKeyRecord.deserialize(stored);
  }

  async removePreKey(id: number): Promise<void> {
    // Keep prekeys for this local demo stack to tolerate repeated/stale prekey bundles.
    // This avoids chat outages when multiple clients initiate sessions concurrently.
    this.store.set("prekey:used:" + id, { usedAt: Date.now() });
  }
}

export class SqliteSignedPreKeyStore extends SignedPreKeyStore {
  constructor(private store: EncryptedStore) {
    super();
  }

  async saveSignedPreKey(id: number, record: SignedPreKeyRecord): Promise<void> {
    this.store.set(`signedprekey:${id}`, record.serialize());
  }

  async getSignedPreKey(id: number): Promise<SignedPreKeyRecord> {
    const stored = this.store.get<Uint8Array>(`signedprekey:${id}`);
    if (!stored) throw new Error(`SignedPreKey ${id} not found`);
    return SignedPreKeyRecord.deserialize(stored);
  }
}

export class SqliteKyberPreKeyStore extends KyberPreKeyStore {
  constructor(private store: EncryptedStore) {
    super();
  }

  async saveKyberPreKey(id: number, record: KyberPreKeyRecord): Promise<void> {
    this.store.set(`kyberprekey:${id}`, record.serialize());
  }

  async getKyberPreKey(id: number): Promise<KyberPreKeyRecord> {
    const stored = this.store.get<Uint8Array>(`kyberprekey:${id}`);
    if (!stored) throw new Error(`KyberPreKey ${id} not found`);
    return KyberPreKeyRecord.deserialize(stored);
  }

  async markKyberPreKeyUsed(id: number, signedPreKeyId: number, baseKey: PublicKey): Promise<void> {
    this.store.set(`kyberprekey:used:${id}`, {
      signedPreKeyId,
      baseKey: baseKey.serialize(),
      usedAt: Date.now()
    });
  }
}

export function loadIdentityKeyPair(store: EncryptedStore): IdentityKeyPair {
  const data = store.get<Uint8Array>("local:identityKeyPair");
  if (!data) throw new Error("Identity key pair not found. Run 'mega init'.");
  return IdentityKeyPair.deserialize(data);
}

export function saveIdentityKeyPair(store: EncryptedStore, pair: IdentityKeyPair): void {
  store.set("local:identityKeyPair", pair.serialize());
}
