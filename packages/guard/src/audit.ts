import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The Guard audit log: local JSONL, hash-chained. Each row's `hash` is sha256 of the previous
 * row's hash and this row's canonical JSON (keys sorted, `hash` left out), so editing, removing
 * or reordering a row breaks every hash after it. It records the decision, rule, tool, program,
 * host, path, project and session. Command text is left out unless `audit.verbose` is set.
 *
 * The chain detects tampering after the fact; it does not prevent someone with write access to
 * the file from rewriting all of it. There is no signing key.
 */

export interface AuditRow {
  at: number;
  /** "deny", "ask", "log", "would-deny" (monitor mode), "would-ask", "policy". */
  decision: string;
  rule?: string;
  scope?: string;
  tool?: string;
  program?: string;
  host?: string;
  path?: string;
  session?: string;
  project?: string;
  agent?: string;
  mode?: string;
  /** Free text for "policy" rows (what changed and why). */
  note?: string;
  /** Only with audit.verbose. */
  command?: string;
}

export interface StoredRow extends AuditRow {
  seq: number;
  prev: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, (x as Record<string, unknown>)[k]]),
        )
      : x,
  );
}

export const chainHash = (prev: string, row: Omit<StoredRow, "hash">) =>
  createHash("sha256").update(prev).update(canonical(row)).digest("hex");

export class AuditLog {
  private last: { seq: number; hash: string } | null = null;

  constructor(readonly file: string) {}

  private tail(): { seq: number; hash: string } {
    if (this.last) return this.last;
    let seq = 0;
    let hash = GENESIS;
    if (existsSync(this.file)) {
      const text = readFileSync(this.file, "utf8");
      const lines = text.split("\n").filter(Boolean);
      const lastLine = lines[lines.length - 1];
      if (lastLine) {
        try {
          const r = JSON.parse(lastLine) as StoredRow;
          seq = r.seq;
          hash = r.hash;
        } catch {}
      }
    }
    this.last = { seq, hash };
    return this.last;
  }

  /** Append one row. Synchronous and small: a hook can afford it. */
  append(row: AuditRow): StoredRow {
    const t = this.tail();
    const stored: Omit<StoredRow, "hash"> = { ...row, seq: t.seq + 1, prev: t.hash };
    const hash = chainHash(t.hash, stored);
    const full: StoredRow = { ...stored, hash };
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    appendFileSync(this.file, `${canonical(full)}\n`, { mode: 0o600 });
    this.last = { seq: full.seq, hash };
    return full;
  }

  rows(): StoredRow[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as StoredRow);
  }

  /** Check the whole chain. `brokenAt` is the first row whose hash or link is wrong. */
  verify(): { ok: boolean; rows: number; brokenAt?: number; reason?: string } {
    if (!existsSync(this.file)) return { ok: true, rows: 0 };
    let prev = GENESIS;
    let n = 0;
    const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      n++;
      let r: StoredRow;
      try {
        r = JSON.parse(line) as StoredRow;
      } catch {
        return { ok: false, rows: lines.length, brokenAt: n, reason: "not valid JSON" };
      }
      const { hash, ...rest } = r;
      if (r.seq !== n)
        return {
          ok: false,
          rows: lines.length,
          brokenAt: n,
          reason: `sequence is ${r.seq}, expected ${n} (a row was removed or reordered)`,
        };
      if (r.prev !== prev)
        return { ok: false, rows: lines.length, brokenAt: n, reason: "does not follow the previous row" };
      if (chainHash(prev, rest) !== hash)
        return {
          ok: false,
          rows: lines.length,
          brokenAt: n,
          reason: "contents do not match the hash (the row was edited)",
        };
      prev = hash;
    }
    return { ok: true, rows: lines.length };
  }

  size(): number {
    try {
      return statSync(this.file).size;
    } catch {
      return 0;
    }
  }
}
