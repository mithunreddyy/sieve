import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Passphrase encryption for exported bundles and synced files (slice 11).
 *
 *   key  = scrypt(passphrase, salt, N=2^15, r=8, p=1) → 32 bytes
 *   file = "SIEVE1" | nonce(12) | tag(16) | AES-256-GCM(ciphertext)
 *
 * GCM authenticates the ciphertext, so a wrong passphrase or any edit to a file is detected
 * rather than decrypted into garbage. A fresh random nonce is used for every file.
 */

const MAGIC = Buffer.from("SIEVE1");

export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  if (passphrase.length < 8) throw new Error("the passphrase must be at least 8 characters");
  return scryptSync(passphrase.normalize("NFKC"), salt, 32, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024,
  });
}

export const newSalt = () => randomBytes(16);

export function seal(plain: Uint8Array, key: Buffer): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, nonce, c.getAuthTag(), body]);
}

/** Decrypt, or throw `Error("wrong passphrase or damaged file")`. */
export function open(file: Uint8Array, key: Buffer): Buffer {
  const b = Buffer.from(file);
  if (b.length < MAGIC.length + 28 || !b.subarray(0, MAGIC.length).equals(MAGIC))
    throw new Error("not a Sieve encrypted file");
  const nonce = b.subarray(6, 18);
  const tag = b.subarray(18, 34);
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(b.subarray(34)), d.final()]);
  } catch {
    throw new Error("wrong passphrase or damaged file");
  }
}

export const isSealed = (b: Uint8Array) => Buffer.from(b.subarray(0, MAGIC.length)).equals(MAGIC);
