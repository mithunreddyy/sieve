import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { terms } from "./memory.ts";
import { countTokens } from "./tokens.ts";

/**
 * Skills (slice 8): instruction files imported from a git URL or a folder, pinned to a commit and
 * checksummed, stored on disk. A prompt that asks for a skill, or matches one's description,
 * brings that skill's text into the context, one skill per turn, with a line saying so.
 *
 * Nothing in a skill is ever executed by Sieve. Only its SKILL.md text is shown to the model, and
 * only if the user enabled it; a skill is added disabled. A stored skill whose files no longer
 * match their checksum is refused.
 */

export interface SkillMeta {
  name: string;
  description: string;
  /** Git URL or absolute folder path it was imported from. */
  source: string;
  /** Commit it was pinned to (null for a plain folder). */
  commit: string | null;
  /** sha256 over every stored file's path and content. */
  checksum: string;
  enabled: boolean;
  addedAt: number;
  bytes: number;
  files: number;
}

export interface SkillMatch {
  skill: SkillMeta;
  how: "requested" | "matched";
  score: number;
  /** Words from the prompt that matched the name or description. */
  words: string[];
}

const MAX_FILE = 256 * 1024;
const MAX_TOTAL = 2 * 1024 * 1024;
const MAX_FILES = 200;
const BODY_TOKENS = 4000;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// ------------------------------------------------------------------ SKILL.md

/** The small YAML subset skills use: `key: value`, quoted values, and `>` / `|` block scalars. */
export function parseSkillFile(text: string): { meta: Record<string, string>; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const meta: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const mm = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(l);
    if (!mm) continue;
    const key = mm[1]!;
    let val = mm[2]!.trim();
    if (/^[>|][+-]?$/.test(val)) {
      const fold = val.startsWith(">");
      const parts: string[] = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]!) || lines[i + 1] === ""))
        parts.push(lines[++i]!.trim());
      val = parts.join(fold ? " " : "\n").trim();
    } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    meta[key] = val;
  }
  return { meta, body: m[2]!.trim() };
}

// ------------------------------------------------------------------ files

function walk(dir: string, root = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name === ".git") continue;
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue; // never follow a link out of the folder
    if (st.isDirectory()) walk(p, root, out);
    else if (st.isFile()) out.push(relative(root, p));
  }
  return out;
}

export function checksumOf(dir: string): { checksum: string; bytes: number; files: number } {
  const h = createHash("sha256");
  let bytes = 0;
  const files = walk(dir);
  for (const f of files) {
    const data = readFileSync(join(dir, f));
    bytes += data.length;
    h.update(`${f}\0${createHash("sha256").update(data).digest("hex")}\n`);
  }
  return { checksum: h.digest("hex"), bytes, files: files.length };
}

/** SKILL.md in this folder, or in the one folder under it that has it. */
function findSkillDir(root: string, sub?: string): string {
  const base = sub ? resolve(root, sub) : root;
  if (relative(root, base).startsWith("..")) throw new Error("--path must stay inside the source");
  if (existsSync(join(base, "SKILL.md"))) return base;
  const found: string[] = [];
  const scan = (d: string, depth: number) => {
    if (depth > 3) return;
    for (const n of readdirSync(d).sort()) {
      if (n === ".git" || n === "node_modules") continue;
      const p = join(d, n);
      if (!lstatSync(p).isDirectory()) continue;
      if (existsSync(join(p, "SKILL.md"))) found.push(relative(root, p));
      else scan(p, depth + 1);
    }
  };
  scan(base, 0);
  if (found.length === 1) return join(root, found[0]!);
  if (!found.length) throw new Error("no SKILL.md found in the source");
  throw new Error(`several skills here; pick one with --path: ${found.slice(0, 12).join(", ")}`);
}

// ------------------------------------------------------------------ the registry

export class Skills {
  private cache: { mtime: number; list: SkillMeta[] } | null = null;

  constructor(readonly dir: string) {}

  private indexFile() {
    return join(this.dir, "index.json");
  }

  list(): SkillMeta[] {
    const f = this.indexFile();
    if (!existsSync(f)) return [];
    const mtime = statSync(f).mtimeMs;
    if (this.cache?.mtime === mtime) return this.cache.list;
    let list: SkillMeta[] = [];
    try {
      const raw = JSON.parse(readFileSync(f, "utf8"));
      if (Array.isArray(raw))
        list = raw.filter((s) => s && typeof s.name === "string" && NAME_RE.test(s.name));
    } catch {}
    this.cache = { mtime, list };
    return list;
  }

  private save(list: SkillMeta[]): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.indexFile()}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      `${JSON.stringify(
        list.sort((a, b) => a.name.localeCompare(b.name)),
        null,
        2,
      )}\n`,
    );
    renameSync(tmp, this.indexFile());
    this.cache = null;
  }

  get(name: string): SkillMeta | undefined {
    return this.list().find((s) => s.name === name);
  }

  enabled(): SkillMeta[] {
    return this.list().filter((s) => s.enabled);
  }

  private files(name: string) {
    return join(this.dir, name, "files");
  }

  /** The folder a loaded skill's text points the model at, for files bundled with it. */
  folder(name: string): string {
    return this.files(name);
  }

  // -------------------------------------------------------------- add / remove

  /**
   * Import a skill from a git URL or a local folder. The result is stored disabled. Cloning a
   * URL is a network call the user asked for by running this command; nothing else here uses the
   * network.
   */
  add(
    source: string,
    opts: {
      name?: string;
      path?: string;
      ref?: string;
      now?: number;
      /** Tests only: let a `file://` URL be cloned, to exercise the clone path without a network. */
      unsafeAllowLocalClone?: boolean;
    } = {},
  ): { skill: SkillMeta; replaced: boolean } {
    const now = opts.now ?? Date.now();
    const tmp = mkdtempSync(join(tmpdir(), "sieve-skill-"));
    try {
      let root: string;
      let commit: string | null = null;
      let stored: string;
      const isUrl = (
        opts.unsafeAllowLocalClone
          ? /^(https:\/\/|ssh:\/\/|file:\/\/|git@[\w.-]+:)/
          : /^(https:\/\/|ssh:\/\/|git@[\w.-]+:)/
      ).test(source);
      if (isUrl) {
        root = join(tmp, "src");
        const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
        const base = [
          "-c",
          "protocol.ext.allow=never",
          "-c",
          `protocol.file.allow=${opts.unsafeAllowLocalClone ? "always" : "never"}`,
        ];
        const sha = opts.ref && /^[0-9a-f]{40}$/i.test(opts.ref);
        const args = [...base, "clone", "--quiet", "--no-recurse-submodules"];
        if (!sha) args.push("--depth", "1", ...(opts.ref ? ["--branch", opts.ref] : []));
        args.push("--", source, root);
        const c = spawnSync("git", args, { env, encoding: "utf8", timeout: 120_000 });
        if (c.status !== 0)
          throw new Error(
            `git clone failed: ${(c.stderr || c.error?.message || "").trim().split("\n").pop()}`,
          );
        if (sha) {
          const k = spawnSync("git", ["-C", root, "checkout", "--quiet", opts.ref!], {
            env,
            encoding: "utf8",
          });
          if (k.status !== 0) throw new Error(`git checkout ${opts.ref} failed: ${k.stderr.trim()}`);
        }
        const h = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
        commit = h.status === 0 ? h.stdout.trim() : null;
        stored = source;
      } else {
        root = resolve(source);
        if (!existsSync(root) || !statSync(root).isDirectory())
          throw new Error(`not a folder or a git URL: ${source}`);
        stored = root;
        // A local folder that is a git checkout is pinned to its current commit too.
        const h = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
        commit = h.status === 0 ? h.stdout.trim() : null;
      }
      const skillDir = findSkillDir(root, opts.path);
      const parsed = parseSkillFile(readFileSync(join(skillDir, "SKILL.md"), "utf8"));
      if (!parsed) throw new Error("SKILL.md needs front matter with a name and a description");
      const name = (opts.name ?? parsed.meta.name ?? basename(skillDir)).toLowerCase();
      if (!NAME_RE.test(name))
        throw new Error(`"${name}" is not a usable skill name (lowercase letters, digits, . _ -)`);
      const description = (parsed.meta.description ?? "").replace(/\s+/g, " ").trim();
      if (!description) throw new Error("SKILL.md needs a description: matching uses it");

      // Copy the vetted file list only: no links, no .git, size and count limits.
      const list = walk(skillDir);
      if (list.length > MAX_FILES) throw new Error(`${list.length} files; at most ${MAX_FILES}`);
      let total = 0;
      for (const f of list) {
        const size = statSync(join(skillDir, f)).size;
        if (size > MAX_FILE)
          throw new Error(`${f} is ${Math.round(size / 1024)} KB; at most ${MAX_FILE / 1024} KB per file`);
        total += size;
      }
      if (total > MAX_TOTAL)
        throw new Error(`${Math.round(total / 1024)} KB in total; at most ${MAX_TOTAL / 1024} KB`);

      const dest = this.files(name);
      const staging = join(tmp, "stage");
      mkdirSync(staging, { recursive: true });
      for (const f of list) {
        const to = join(staging, f);
        mkdirSync(join(to, ".."), { recursive: true });
        cpSync(join(skillDir, f), to);
      }
      const sum = checksumOf(staging);
      const existing = this.get(name);
      rmSync(join(this.dir, name), { recursive: true, force: true });
      mkdirSync(join(this.dir, name), { recursive: true });
      cpSync(staging, dest, { recursive: true });
      const skill: SkillMeta = {
        name,
        description,
        source: stored,
        commit,
        checksum: sum.checksum,
        enabled: false, // the user turns it on after seeing what it is
        addedAt: now,
        bytes: sum.bytes,
        files: sum.files,
      };
      this.save([...this.list().filter((s) => s.name !== name), skill]);
      return { skill, replaced: !!existing };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  setEnabled(name: string, on: boolean): SkillMeta {
    const s = this.get(name);
    if (!s) throw new Error(`no skill named ${name}`);
    if (on) {
      const v = this.verify(name);
      if (!v.ok) throw new Error(`not enabled: ${v.reason}`);
    }
    const next = { ...s, enabled: on };
    this.save([...this.list().filter((x) => x.name !== name), next]);
    return next;
  }

  remove(name: string): boolean {
    if (!this.get(name)) return false;
    rmSync(join(this.dir, name), { recursive: true, force: true });
    this.save(this.list().filter((s) => s.name !== name));
    return true;
  }

  /** Do the stored files still match the checksum recorded when they were imported? */
  verify(name: string): { ok: true } | { ok: false; reason: string } {
    const s = this.get(name);
    if (!s) return { ok: false, reason: `no skill named ${name}` };
    const dir = this.files(name);
    if (!existsSync(dir)) return { ok: false, reason: `${name}: files are missing` };
    const now = checksumOf(dir);
    return now.checksum === s.checksum
      ? { ok: true }
      : {
          ok: false,
          reason: `${name}: files changed since import (checksum ${now.checksum.slice(0, 8)} ≠ ${s.checksum.slice(0, 8)}); re-add it to trust it again`,
        };
  }

  /** The SKILL.md text (front matter removed), cut at a line boundary if it is long. */
  body(name: string): { text: string; tokens: number; truncated: boolean } | null {
    const f = join(this.files(name), "SKILL.md");
    if (!existsSync(f)) return null;
    const parsed = parseSkillFile(readFileSync(f, "utf8"));
    if (!parsed) return null;
    let text = parsed.body;
    let truncated = false;
    if (countTokens(text) > BODY_TOKENS) {
      truncated = true;
      const lines = text.split("\n");
      while (lines.length > 1 && countTokens(lines.join("\n")) > BODY_TOKENS)
        lines.length = Math.floor(lines.length * 0.9);
      text = lines.join("\n");
    }
    return { text, tokens: countTokens(text), truncated };
  }

  // -------------------------------------------------------------- the always-there lines

  /** One line per enabled skill; the same text every time, so it caches. */
  lines(): string[] {
    return this.enabled().map(
      (s) => `- ${s.name}: ${s.description.length > 110 ? `${s.description.slice(0, 109)}…` : s.description}`,
    );
  }

  /** What the lines cost in tokens, shown by `sieve skills list`. */
  listCost(): number {
    const l = this.lines();
    return l.length ? countTokens(["[sieve skills]", ...l].join("\n")) : 0;
  }

  // -------------------------------------------------------------- matching

  /**
   * Which one skill (if any) this prompt is about. A skill the prompt asks for by name always
   * wins. Otherwise BM25 over name and description must clear a bar (at least two distinct words
   * in common), and a prompt that only mentions the skill (asks what it is, quotes its name,
   * talks about removing it) loads nothing.
   */
  match(prompt: string, skip: ReadonlySet<string> = new Set()): SkillMatch | null {
    const pool = this.enabled();
    if (!pool.length) return null;
    const text = prompt.slice(0, 4000);
    const lower = text.toLowerCase();

    // 1. asked for by name
    for (const s of pool) {
      if (requested(lower, s.name)) return { skill: s, how: "requested", score: Infinity, words: [s.name] };
    }
    // 2. mentioned only: never auto-loaded
    const mentioned = new Set(pool.filter((s) => mentionedOnly(lower, s.name)).map((s) => s.name));

    // 3. matched by description
    const q = terms(text);
    if (q.length < 2) return null;
    const docs = pool.map((s) => ({ s, words: terms(`${s.name} ${s.name} ${s.description}`) }));
    const avg = docs.reduce((n, d) => n + d.words.length, 0) / docs.length || 1;
    const df = new Map<string, number>();
    for (const d of docs) for (const w of new Set(d.words)) df.set(w, (df.get(w) ?? 0) + 1);
    let best: SkillMatch | null = null;
    for (const d of docs) {
      if (skip.has(d.s.name) || mentioned.has(d.s.name)) continue;
      const tf = new Map<string, number>();
      for (const w of d.words) tf.set(w, (tf.get(w) ?? 0) + 1);
      let score = 0;
      const hit: string[] = [];
      for (const w of q) {
        const f = tf.get(w);
        if (!f) continue;
        hit.push(w);
        const n = df.get(w) ?? 0;
        const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
        score += (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.words.length / avg)));
      }
      if (hit.length >= 2 && score >= MATCH_SCORE && (!best || score > best.score))
        best = { skill: d.s, how: "matched", score, words: hit };
    }
    return best;
  }
}

/** Score a prompt must reach to load a skill it did not name. Tuned in the tests. */
export const MATCH_SCORE = 1.6;

const ASKING = "use|run|apply|follow|invoke|load|activate|try|start|do|using|with";

function requested(lower: string, name: string): boolean {
  const n = reEscape(name);
  if (new RegExp(`(^|\\s)/${n}(\\s|$|[.,;:!?])`).test(lower)) return true;
  if (
    new RegExp(`\\b(${ASKING})\\b[^.?!\\n]{0,40}\\b${n}\\b(\\s+skill)?`).test(lower) &&
    !mentionedOnly(lower, name)
  )
    return true;
  return new RegExp(`\\b${n}\\s+skill\\b`).test(lower) && !mentionedOnly(lower, name);
}

function mentionedOnly(lower: string, name: string): boolean {
  const n = reEscape(name);
  if (!new RegExp(`\\b${n}\\b`).test(lower)) return false;
  const about = `(about|what is|what's|whats|explain|describe|why|how does|how do|read|show|review|rename|delete|remove|disable|enable|uninstall|list|where is|who wrote)`;
  if (new RegExp(`\\b${about}\\b[^.?!\\n]{0,30}\\b${n}\\b`).test(lower)) return true;
  // quoted or in code: talking about it, not asking for it
  return (
    new RegExp(`(["'\`])[^"'\`\\n]*\\b${n}\\b[^"'\`\\n]*\\1`).test(lower) &&
    !new RegExp(`(^|\\s)/${n}\\b`).test(lower)
  );
}

function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
