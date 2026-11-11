import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Secret masking (slice 6). Applied before anything is stored: archive content, log rows,
 * decisions, command keys, symbol signatures. A secret becomes `<secret:kind#N>`, where N is
 * the order of first appearance of that distinct secret of that kind in the text, so the same
 * text always gives the same bytes (receipts stay cache-safe) and a repeated secret keeps one
 * token. Masking is idempotent: a masked text masks to itself.
 *
 * It is a net, not a guarantee: known key formats, private keys, URL passwords, values assigned
 * to secret-looking names, values from the project's .env files, and long random-looking
 * tokens. It leaves hashes, UUIDs, lockfile integrity strings and placeholders alone, because
 * masking those would destroy ordinary content (the originals are otherwise exact).
 */

export interface MaskOptions {
  /** Exact values to mask wherever they appear (the project's .env values). */
  values?: readonly string[];
}

export interface MaskResult {
  text: string;
  /** What was masked, by kind: [{kind: "aws_key", count: 1}]. */
  hits: Array<{ kind: string; count: number }>;
}

interface Found {
  start: number;
  end: number;
  kind: string;
  value: string;
}

const KEYWORDS =
  "secret|token|passw(?:or)?d|api[_-]?key|apikey|private[_-]?key|access[_-]?key|signing[_-]?key|encryption[_-]?key|credentials?";

/** Fixed-format secrets: the whole match is the secret. */
const FORMATS: Array<{ kind: string; re: RegExp }> = [
  {
    kind: "private_key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    kind: "private_key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----\r?\n(?:[A-Za-z0-9+/=]{16,}\r?\n?)+/g,
  },
  { kind: "aws_key", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{16}\b/g },
  { kind: "github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
  { kind: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "stripe_key", re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "openai_key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g },
  { kind: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "npm_token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
];

/** Context secrets: group 1 is the secret, the rest is context that stays readable. */
const CONTEXT: Array<{ kind: string; re: RegExp }> = [
  { kind: "aws_secret", re: /aws_?secret_?(?:access_?)?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})\b/gi },
  { kind: "bearer_token", re: /\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/g },
  {
    kind: "auth_header",
    re: /\bAuthorization["']?\s*[:=]\s*["']?(?:Basic|Token|Digest)\s+([A-Za-z0-9._~+/=-]{8,})/gi,
  },
  { kind: "url_password", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]{3,})@/gi },
  // curl -u user:password / --user user:password (not uid:gid, which is all digits)
  { kind: "cli_password", re: /(?:^|\s)(?:-u|--user)[ =]['"]?[^\s:'"]+:([^\s'"]{6,})/g },
  // --password VALUE / --token=VALUE / --api-key VALUE and the like
  {
    kind: "cli_secret",
    re: /(?:^|\s)--(?:password|passwd|token|api-?key|secret|auth-?token|access-?token|client-?secret)[ =]['"]?([^\s'"-][^\s'"]{7,})/gi,
  },
];

const ASSIGNED = new RegExp(
  `([A-Za-z0-9_.-]*(?:${KEYWORDS}))["']?\\s*[:=]\\s*["']?([^\\s"'#,;)}\\]]{8,})`,
  "gi",
);

export function entropy(s: string): number {
  const n = s.length;
  if (!n) return 0;
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) h -= (c / n) * Math.log2(c / n);
  return h;
}

/** Values that name or reference a secret rather than being one. */
function looksLikeReference(v: string): boolean {
  if (/^<secret:/.test(v)) return true;
  if (/[(){}[\]<>$\\`|]/.test(v)) return true; // calls, templates, shell variables
  if (/^[./~]/.test(v) || /^[A-Za-z]:[\\/]/.test(v)) return true; // paths
  if (
    /^(?:null|none|nil|true|false|undefined|required|optional|string|number|boolean|changeme|example|your[_-].*|xxx+|\*+)$/i.test(
      v,
    )
  )
    return true;
  if (/^([A-Za-z0-9])\1+$/.test(v)) return true; // aaaaaaaa, 00000000
  if (/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(v)) return true; // settings.token, process.env.X
  if (/^[a-z]+(?:[-_][a-z]+)+$/.test(v)) return true; // a lowercase slug (private-token): a placeholder far more often than a password
  return false;
}

const isHash = (t: string) => /^[0-9a-f]+$/i.test(t) && [32, 40, 56, 64, 96, 128].includes(t.length);
const isUuid = (t: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t);

/** Long random-looking tokens on their own (not hashes, UUIDs, SRI strings or paths). */
const STANDALONE = /(?<![A-Za-z0-9_/+=.-])[A-Za-z0-9_+/=-]{40,100}(?![A-Za-z0-9_/+=.-])/g;
/** Public data that looks random: integrity hashes, signatures, fingerprints, inline base64. */
const PUBLIC_BEFORE =
  /(?:sha(?:1|256|384|512)[-:]|base64,|(?:integrity|signature|sig|checksum|digest|hash|fingerprint|keyid|etag)["']?\s*[:=]\s*["']?)$/i;

/** An alphabet or counting sequence (0-9A-Za-z) has high entropy and no secret in it. */
function isSequence(t: string): boolean {
  let up = 0;
  for (let i = 1; i < t.length; i++) if (t.charCodeAt(i) - t.charCodeAt(i - 1) === 1) up++;
  return up / (t.length - 1) > 0.5;
}

function standalone(text: string, out: Found[]): void {
  for (const m of text.matchAll(STANDALONE)) {
    const t = m[0];
    const start = m.index!;
    if (isHash(t) || isUuid(t)) continue;
    if (/^sha(?:1|256|384|512)-/i.test(t)) continue;
    if (PUBLIC_BEFORE.test(text.slice(Math.max(0, start - 24), start))) continue;
    if (isSequence(t)) continue;
    const classes = Number(/[a-z]/.test(t)) + Number(/[A-Z]/.test(t)) + Number(/[0-9]/.test(t));
    if (classes < 3) continue;
    if (/^[A-Za-z]+(?:[A-Z][a-z]+)+$/.test(t)) continue; // a long camelCase identifier
    if (entropy(t) < 4.5) continue;
    out.push({ start, end: start + t.length, kind: "high_entropy", value: t });
  }
}

/** Cheap guard: most text has none of these and skips the heavier scans. */
const HINT =
  /BEGIN|AKIA|ASIA|gh[pousr]_|github_pat_|xox|_live_|_test_|sk-|AIza|npm_|eyJ|Bearer|Authorization|:\/\/|secret|token|passw|key|credential|[A-Za-z0-9_+/=-]{40}/i;

export function maskSecrets(text: string, opts: MaskOptions = {}): MaskResult {
  const values = opts.values?.filter((v) => v.length >= 8) ?? [];
  if (!text || (!HINT.test(text) && !values.length)) return { text, hits: [] };
  const found: Found[] = [];
  for (const { kind, re } of FORMATS)
    for (const m of text.matchAll(re))
      found.push({ start: m.index!, end: m.index! + m[0].length, kind, value: m[0] });
  for (const { kind, re } of CONTEXT)
    for (const m of text.matchAll(re)) {
      const v = m[1]!;
      if (looksLikeReference(v) || (kind === "cli_password" && /^\d+$/.test(v))) continue;
      const start = m.index! + m[0].lastIndexOf(v);
      found.push({ start, end: start + v.length, kind, value: v });
    }
  for (const m of text.matchAll(ASSIGNED)) {
    const v = m[2]!;
    if (looksLikeReference(v) || isHash(v) || isUuid(v)) continue;
    if (!/[0-9]/.test(v) && entropy(v) < 3.3) continue;
    const start = m.index! + m[0].length - v.length;
    found.push({ start, end: start + v.length, kind: "secret_value", value: v });
  }
  standalone(text, found);
  for (const val of values) {
    for (let i = text.indexOf(val); i !== -1; i = text.indexOf(val, i + val.length))
      found.push({ start: i, end: i + val.length, kind: "env_value", value: val });
  }
  if (!found.length) return { text, hits: [] };

  // Earlier start wins; at the same start the longer match wins; overlaps are dropped.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Found[] = [];
  let upto = 0;
  for (const f of found) {
    if (f.start < upto) continue;
    kept.push(f);
    upto = f.end;
  }
  const seen = new Map<string, Map<string, number>>();
  const counts = new Map<string, number>();
  let out = "";
  let at = 0;
  for (const f of kept) {
    const byValue = seen.get(f.kind) ?? new Map<string, number>();
    seen.set(f.kind, byValue);
    const n = byValue.get(f.value) ?? byValue.size + 1;
    byValue.set(f.value, n);
    counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
    out += `${text.slice(at, f.start)}<secret:${f.kind}#${n}>`;
    at = f.end;
  }
  out += text.slice(at);
  return { text: out, hits: [...counts].map(([kind, count]) => ({ kind, count })) };
}

export const mask = (text: string, opts?: MaskOptions) => maskSecrets(text, opts).text;

/** "2 secrets masked (aws_key ×1, jwt ×1)", or "" when nothing was. */
export function describeHits(hits: MaskResult["hits"]): string {
  const n = hits.reduce((s, h) => s + h.count, 0);
  if (!n) return "";
  return `${n} secret${n === 1 ? "" : "s"} masked (${hits.map((h) => `${h.kind} ×${h.count}`).join(", ")})`;
}

// ------------------------------------------------------------------ .env values

const ENV_SKIP = /\.(?:example|sample|template|dist|defaults?)$/i;

/** Values in the project's `.env` and `.env.*` files (top level), for exact masking. */
export function readEnvValues(dir: string): string[] {
  const vals = new Set<string>();
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => (n === ".env" || n.startsWith(".env.")) && !ENV_SKIP.test(n));
  } catch {
    return [];
  }
  for (const n of names) {
    const f = join(dir, n);
    try {
      if (!statSync(f).isFile() || statSync(f).size > 256 * 1024) continue;
      for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        let v = m[1]!.trim();
        if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
        else v = v.replace(/\s+#.*$/, "");
        if (
          v.length >= 8 &&
          !looksLikeReference(v) &&
          !/^(?:localhost|development|production|test|staging)$/i.test(v)
        )
          vals.add(v);
      }
    } catch {}
  }
  return [...vals].sort((a, b) => b.length - a.length);
}

/** `readEnvValues` with a cache keyed by the files' modification times. */
export class EnvValues {
  private cache = new Map<string, { sig: string; values: string[]; at: number }>();

  get(dir: string, now = Date.now()): string[] {
    const hit = this.cache.get(dir);
    if (hit && now - hit.at < 2000) return hit.values;
    let sig = "";
    try {
      for (const n of readdirSync(dir)
        .filter((x) => (x === ".env" || x.startsWith(".env.")) && !ENV_SKIP.test(x))
        .sort()) {
        const st = statSync(join(dir, n));
        sig += `${n}:${st.size}:${st.mtimeMs};`;
      }
    } catch {}
    if (hit && hit.sig === sig) {
      hit.at = now;
      return hit.values;
    }
    const values = sig && existsSync(dir) ? readEnvValues(dir) : [];
    this.cache.set(dir, { sig, values, at: now });
    return values;
  }
}
