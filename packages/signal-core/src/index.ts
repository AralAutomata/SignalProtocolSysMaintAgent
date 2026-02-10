import crypto from "node:crypto";
import {
  CiphertextMessageType,
  IdentityKeyPair,
  KEMKeyPair,
  KEMPublicKey,
  PreKeyBundle,
  PreKeyRecord,
  PreKeySignalMessage,
  PrivateKey,
  ProtocolAddress,
  PublicKey,
  SignalMessage,
  SignedPreKeyRecord,
  KyberPreKeyRecord,
  processPreKeyBundle,
  signalDecrypt,
  signalDecryptPreKey,
  signalEncrypt
} from "@signalapp/libsignal-client";
import { parseEnvelope, type Envelope } from "@mega/shared";
import { fromBase64, toBase64 } from "./crypto.js";
import {
  EncryptedStore,
  SqliteIdentityStore,
  SqliteKyberPreKeyStore,
  SqlitePreKeyStore,
  SqliteSessionStore,
  SqliteSignedPreKeyStore,
  loadIdentityKeyPair,
  saveIdentityKeyPair
} from "./store.js";

export type Bundle = {
  id: string;
  deviceId: number;
  registrationId: number;
  identityKey: string;
  signedPreKey: {
    keyId: number;
    publicKey: string;
    signature: string;
  };
  preKey: {
    keyId: number;
    publicKey: string;
  };
  kyberPreKey: {
    keyId: number;
    publicKey: string;
    signature: string;
  };
};

export type InboxMessage = {
  id: string;
  senderId: string;
  timestamp: number;
  plaintext: string;
  envelope: Envelope;
};

const COUNTER_PREKEY = "counter:prekey";
const COUNTER_SIGNED_PREKEY = "counter:signedprekey";
const COUNTER_KYBER_PREKEY = "counter:kyberprekey";

export class SignalState {
  readonly store: EncryptedStore;
  readonly identityStore: SqliteIdentityStore;
  readonly sessionStore: SqliteSessionStore;
  readonly preKeyStore: SqlitePreKeyStore;
  readonly signedPreKeyStore: SqliteSignedPreKeyStore;
  readonly kyberPreKeyStore: SqliteKyberPreKeyStore;

  constructor(dbPath: string, passphrase: string) {
    this.store = new EncryptedStore(dbPath, passphrase);
    this.identityStore = new SqliteIdentityStore(this.store);
    this.sessionStore = new SqliteSessionStore(this.store);
    this.preKeyStore = new SqlitePreKeyStore(this.store);
    this.signedPreKeyStore = new SqliteSignedPreKeyStore(this.store);
    this.kyberPreKeyStore = new SqliteKyberPreKeyStore(this.store);
  }

  getLocalIdentity(): string | undefined {
    return this.store.getLocalId();
  }

  setLocalIdentity(id: string): void {
    this.store.setLocalId(id);
  }

  getDeviceId(): number {
    return this.store.getDeviceId() ?? 1;
  }

  setDeviceId(id: number): void {
    this.store.setDeviceId(id);
  }

  getRegistrationId(): number | undefined {
    return this.store.getRegistrationId();
  }

  setRegistrationId(id: number): void {
    this.store.setRegistrationId(id);
  }

  getIdentityKeyPair(): IdentityKeyPair {
    return loadIdentityKeyPair(this.store);
  }

  setIdentityKeyPair(pair: IdentityKeyPair): void {
    saveIdentityKeyPair(this.store, pair);
  }

  getValue<T>(key: string): T | undefined {
    return this.store.get<T>(key);
  }

  setValue(key: string, value: unknown): void {
    this.store.set(key, value);
  }
}

export function openStore(dbPath: string, passphrase: string): SignalState {
  return new SignalState(dbPath, passphrase);
}

export async function initializeIdentity(state: SignalState, localId: string, deviceId = 1): Promise<void> {
  const registrationId = crypto.randomInt(1, 16380);
  const identityKeyPair = IdentityKeyPair.generate();

  state.setLocalIdentity(localId);
  state.setDeviceId(deviceId);
  state.setRegistrationId(registrationId);
  state.setIdentityKeyPair(identityKeyPair);
}

function nextCounter(state: SignalState, key: string, start = 1): number {
  const current = state.getValue<number>(key) ?? start;
  state.setValue(key, current + 1);
  return current;
}

export async function generatePreKeys(state: SignalState, count = 1): Promise<void> {
  const identityKeyPair = state.getIdentityKeyPair();

  for (let i = 0; i < count; i += 1) {
    const preKeyId = nextCounter(state, COUNTER_PREKEY);
    const preKeyPrivate = PrivateKey.generate();
    const preKeyRecord = PreKeyRecord.new(preKeyId, preKeyPrivate.getPublicKey(), preKeyPrivate);
    await state.preKeyStore.savePreKey(preKeyId, preKeyRecord);
  }

  const signedPreKeyId = nextCounter(state, COUNTER_SIGNED_PREKEY);
  const signedPreKeyPrivate = PrivateKey.generate();
  const signedPreKeyPublic = signedPreKeyPrivate.getPublicKey();
  const signedSignature = identityKeyPair.privateKey.sign(signedPreKeyPublic.serialize());
  const signedPreKeyRecord = SignedPreKeyRecord.new(
    signedPreKeyId,
    Date.now(),
    signedPreKeyPublic,
    signedPreKeyPrivate,
    signedSignature
  );
  await state.signedPreKeyStore.saveSignedPreKey(signedPreKeyId, signedPreKeyRecord);

  const kyberPreKeyId = nextCounter(state, COUNTER_KYBER_PREKEY);
  const kemKeyPair = KEMKeyPair.generate();
  const kyberSignature = identityKeyPair.privateKey.sign(kemKeyPair.getPublicKey().serialize());
  const kyberRecord = KyberPreKeyRecord.new(kyberPreKeyId, Date.now(), kemKeyPair, kyberSignature);
  await state.kyberPreKeyStore.saveKyberPreKey(kyberPreKeyId, kyberRecord);
}

export async function exportBundle(state: SignalState): Promise<Bundle> {
  const identityKeyPair = state.getIdentityKeyPair();
  const registrationId = state.getRegistrationId();
  const localId = state.getLocalIdentity();
  if (!localId || registrationId === undefined) throw new Error("Local identity not set. Run 'mega init'.");
  const deviceId = state.getDeviceId();

  const signedPreKeyId = (state.getValue<number>(COUNTER_SIGNED_PREKEY) ?? 2) - 1;
  const preKeyId = (state.getValue<number>(COUNTER_PREKEY) ?? 2) - 1;
  const kyberPreKeyId = (state.getValue<number>(COUNTER_KYBER_PREKEY) ?? 2) - 1;

  const signedPreKey = await state.signedPreKeyStore.getSignedPreKey(signedPreKeyId);
  const preKey = await state.preKeyStore.getPreKey(preKeyId);
  const kyberPreKey = await state.kyberPreKeyStore.getKyberPreKey(kyberPreKeyId);

  return {
    id: localId,
    deviceId,
    registrationId,
    identityKey: toBase64(identityKeyPair.publicKey.serialize()),
    signedPreKey: {
      keyId: signedPreKeyId,
      publicKey: toBase64(signedPreKey.publicKey().serialize()),
      signature: toBase64(signedPreKey.signature())
    },
    preKey: {
      keyId: preKeyId,
      publicKey: toBase64(preKey.publicKey().serialize())
    },
    kyberPreKey: {
      keyId: kyberPreKeyId,
      publicKey: toBase64(kyberPreKey.publicKey().serialize()),
      signature: toBase64(kyberPreKey.signature())
    }
  };
}

export async function initSession(state: SignalState, bundle: Bundle): Promise<void> {
  const address = ProtocolAddress.new(bundle.id, bundle.deviceId);
  const preKeyBundle = PreKeyBundle.new(
    bundle.registrationId,
    bundle.deviceId,
    bundle.preKey.keyId,
    PublicKey.deserialize(fromBase64(bundle.preKey.publicKey)),
    bundle.signedPreKey.keyId,
    PublicKey.deserialize(fromBase64(bundle.signedPreKey.publicKey)),
    fromBase64(bundle.signedPreKey.signature),
    PublicKey.deserialize(fromBase64(bundle.identityKey)),
    bundle.kyberPreKey.keyId,
    KEMPublicKey.deserialize(fromBase64(bundle.kyberPreKey.publicKey)),
    fromBase64(bundle.kyberPreKey.signature)
  );

  await processPreKeyBundle(preKeyBundle, address, state.sessionStore, state.identityStore);
}

export async function encryptMessage(state: SignalState, recipientId: string, plaintext: string): Promise<Envelope> {
  const address = ProtocolAddress.new(recipientId, 1);
  const ciphertext = await signalEncrypt(new TextEncoder().encode(plaintext), address, state.sessionStore, state.identityStore);

  const senderId = state.getLocalIdentity();
  if (!senderId) throw new Error("Local identity not set. Run 'mega init'.");

  return {
    version: 1,
    senderId,
    recipientId,
    sessionId: `${senderId}::${recipientId}`,
    type: ciphertext.type(),
    body: toBase64(ciphertext.serialize()),
    timestamp: Date.now()
  };
}

export async function decryptMessage(state: SignalState, envelope: Envelope): Promise<string> {
  const address = ProtocolAddress.new(envelope.senderId, 1);
  const bytes = fromBase64(envelope.body);

  if (envelope.type !== CiphertextMessageType.PreKey && envelope.type !== CiphertextMessageType.Whisper) {
    throw new Error(`Unsupported ciphertext type: ${envelope.type}`);
  }

  const plaintextBuffer =
    envelope.type === CiphertextMessageType.PreKey
      ? await signalDecryptPreKey(
          PreKeySignalMessage.deserialize(bytes),
          address,
          state.sessionStore,
          state.identityStore,
          state.preKeyStore,
          state.signedPreKeyStore,
          state.kyberPreKeyStore
        )
      : await signalDecrypt(SignalMessage.deserialize(bytes), address, state.sessionStore, state.identityStore);

  return new TextDecoder().decode(plaintextBuffer);
}

export function loadEnvelope(input: unknown): Envelope {
  return parseEnvelope(input);
}

const INBOX_PREFIX = "inbox:";

export function saveInboxMessage(state: SignalState, message: InboxMessage): void {
  state.store.set(`${INBOX_PREFIX}${message.id}`, message);
}

export function listInboxMessages(state: SignalState): InboxMessage[] {
  const keys = state.store.listKeysByPrefix(INBOX_PREFIX);
  const messages: InboxMessage[] = [];
  for (const key of keys) {
    const msg = state.store.get<InboxMessage>(key);
    if (msg) messages.push(msg);
  }
  messages.sort((a, b) => a.timestamp - b.timestamp);
  return messages;
}

export {
  EncryptedStore,
  SqliteIdentityStore,
  SqliteSessionStore,
  SqlitePreKeyStore,
  SqliteSignedPreKeyStore,
  SqliteKyberPreKeyStore
};
