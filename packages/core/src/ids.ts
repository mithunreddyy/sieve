import { createHash, randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, no padding. */
export function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Content-addressed archive id: the same bytes always get the same id (ADR 0003). */
export function archiveId(content: string): string {
  return `s_${base32(createHash("sha256").update(content).digest()).slice(0, 12)}`;
}

export function jobId(): string {
  return `j_${base32(randomBytes(8)).slice(0, 12)}`;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
