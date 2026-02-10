import crypto from "node:crypto";
import { Buffer } from "node:buffer";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export type KdfParams = {
  salt: string;
  n: number;
  r: number;
  p: number;
  keyLen: number;
};

export function createKdfParams(): KdfParams {
  return {
    salt: crypto.randomBytes(16).toString("base64"),
    n: 16384,
    r: 8,
    p: 1,
    keyLen: 32
  };
}

export function deriveKey(passphrase: string, params: KdfParams): Buffer {
  const salt = Buffer.from(params.salt, "base64");
  return crypto.scryptSync(passphrase, salt, params.keyLen, {
    N: params.n,
    r: params.r,
    p: params.p
  });
}

export function encryptBuffer(key: Buffer, plaintext: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

export function decryptBuffer(key: Buffer, payload: Buffer): Buffer {
  const iv = payload.subarray(0, IV_LENGTH);
  const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encodeValue(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val instanceof ArrayBuffer) {
      return {
        __type: "ab",
        data: Buffer.from(val).toString("base64")
      };
    }
    if (ArrayBuffer.isView(val)) {
      const buf = Buffer.from(val.buffer, val.byteOffset, val.byteLength);
      return {
        __type: "ab",
        data: buf.toString("base64")
      };
    }
    return val;
  });
}

export function decodeValue(text: string): unknown {
  return JSON.parse(text, (_key, val) => {
    if (val && typeof val === "object" && val.__type === "ab") {
      const buf = Buffer.from(val.data, "base64");
      return new Uint8Array(buf);
    }
    return val;
  });
}

export function encryptJson(key: Buffer, value: unknown): Buffer {
  const encoded = encodeValue(value);
  return encryptBuffer(key, Buffer.from(encoded, "utf8"));
}

export function decryptJson(key: Buffer, payload: Buffer): unknown {
  const decoded = decryptBuffer(key, payload).toString("utf8");
  return decodeValue(decoded);
}

export function buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
}

export function toBase64(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return Buffer.from(bytes).toString("base64");
}

export function fromBase64(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, "base64"));
}
