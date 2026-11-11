/**
 * A shell command parser for Guard (slice 7). It does not execute or expand anything: it splits
 * a command line into simple commands (with the operator that joined them, the pipeline they
 * belong to, redirections, and heredocs), pulls out command substitutions `$(…)`, backticks and
 * `<(…)` as commands of their own, and strips quotes. It reads POSIX-style shell (bash, zsh,
 * sh); PowerShell and cmd are not parsed.
 *
 * Quoting can neither hide nor fake an operator: redirects, heredocs and separators are
 * recognised on unquoted characters only, in the tokenizer.
 */

export type Operator = ";" | "&&" | "||" | "|" | "&";

export interface Redirect {
  op: ">" | ">>" | "<" | "<<";
  /** Target as written, quotes removed. */
  target: string;
  fd?: number;
}

export interface Cmd {
  /** Words after quote removal; the first is the program (after env assignments are split off). */
  words: string[];
  env: Record<string, string>;
  redirects: Redirect[];
  /** Body of a heredoc attached to this command. */
  heredoc?: string;
  /** The text of this command as written. */
  raw: string;
  /** How it was joined to the previous command (null for the first). */
  op: Operator | null;
  /** Commands joined by `|` share a pipeline id. */
  pipeline: number;
  /** Position inside its pipeline (0 = first). */
  stage: number;
  /** Came from `$(…)`, backticks or `<(…)` inside the command with this index (in the same list). */
  substitutionOf?: number;
  /** Nesting depth of the parse (substitutions). */
  depth: number;
}

/** A segment starting with one of these is not a command (loop headers, closers). */
const SKIP_SEGMENT = new Set(["for", "case", "select", "function", "done", "fi", "esac", "}"]);
/** Keywords and grouping that precede a real command. */
const STRIP_LEADING = new Set(["if", "then", "elif", "else", "while", "until", "do", "!", "{"]);

const MAX_DEPTH = 6;
const MAX_COMMANDS = 400;

interface Word {
  text: string;
  quoted: boolean;
  /** A redirect operator (`>`, `2>>`, `<<-`, …) written outside quotes. */
  op?: true;
}

/** The index of the `)` closing the `(` at s[i], skipping quotes and escapes; -1 if unterminated. */
function matchParen(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j]!;
    if (c === "\\") j++;
    else if (c === "'") {
      const e = s.indexOf("'", j + 1);
      if (e === -1) return -1;
      j = e;
    } else if (c === '"') {
      for (j++; j < s.length && s[j] !== '"'; j++) if (s[j] === "\\") j++;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return j;
  }
  return -1;
}

const REDIRECT = /^(\d*)(>>|>&|>\||>|<<<|<<-?|<&|<>|<)$/;

/** Parse a command line. Never throws: unparseable input yields the commands found so far. */
export function parseShell(input: string, depth = 0): Cmd[] {
  const src = input.replace(/\\\r?\n/g, "");
  const n = src.length;
  const out: Cmd[] = [];
  const subQueue: Array<{ code: string; owner: number }> = [];
  const pendingHeredocs: Array<{ cmd: Cmd; delim: string; strip: boolean }> = [];

  let words: Word[] = [];
  let subs: string[] = [];
  let cur = "";
  let inWord = false;
  let curQuoted = false;
  let segStart = 0;
  let op: Operator | null = null;
  let pipeline = 0;
  let stage = 0;

  const pushWord = () => {
    if (inWord) words.push({ text: cur, quoted: curQuoted });
    cur = "";
    inWord = false;
    curQuoted = false;
  };

  const finishCmd = (end: number, nextOp: Operator | null) => {
    pushWord();
    let ws = words;
    words = [];
    const owned = subs;
    subs = [];
    while (ws.length && !ws[0]!.quoted && !ws[0]!.op && STRIP_LEADING.has(ws[0]!.text)) ws = ws.slice(1);
    if (ws.length && !ws[0]!.quoted && SKIP_SEGMENT.has(ws[0]!.text)) ws = [];
    const cmd: Cmd = {
      words: [],
      env: {},
      redirects: [],
      raw: src.slice(segStart, end).trim(),
      op,
      pipeline,
      stage,
      depth,
    };
    let i = 0;
    for (; i < ws.length && !ws[i]!.op; i++) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(ws[i]!.text);
      if (!m) break;
      cmd.env[m[1]!] = m[2]!;
    }
    for (; i < ws.length; i++) {
      const w = ws[i]!;
      if (!w.op) {
        cmd.words.push(w.text);
        continue;
      }
      const r = REDIRECT.exec(w.text)!;
      const target = ws[i + 1]?.text ?? "";
      i++; // the target word belongs to the operator
      if (r[2] === ">&" || r[2] === "<&") {
        if (/^\d+$|^-$/.test(target)) continue; // 2>&1 duplicates a descriptor; nothing is written
        cmd.redirects.push({ op: ">", target, ...(r[1] ? { fd: Number(r[1]) } : {}) }); // >&file
        continue;
      }
      if (r[2] === "<<<") continue; // here-string: data, not a file
      const kind: Redirect["op"] = r[2]!.startsWith("<<")
        ? "<<"
        : r[2] === ">|"
          ? ">"
          : r[2] === "<>"
            ? "<"
            : (r[2] as Redirect["op"]);
      cmd.redirects.push({ op: kind, target, ...(r[1] ? { fd: Number(r[1]) } : {}) });
      if (kind === "<<") pendingHeredocs.push({ cmd, delim: target, strip: r[2] === "<<-" });
    }
    if (cmd.words.length || Object.keys(cmd.env).length || cmd.redirects.length) {
      const idx = out.length;
      out.push(cmd);
      for (const code of owned) subQueue.push({ code, owner: idx });
    }
    if (nextOp === "|") stage++;
    else {
      pipeline++;
      stage = 0;
    }
    op = nextOp;
  };

  let i = 0;
  while (i < n && out.length < MAX_COMMANDS) {
    const c = src[i]!;
    if (c === "\\") {
      cur += src[i + 1] ?? "";
      inWord = true;
      i += 2;
    } else if (c === "'") {
      const e = src.indexOf("'", i + 1);
      cur += src.slice(i + 1, e === -1 ? n : e);
      inWord = curQuoted = true;
      i = e === -1 ? n : e + 1;
    } else if (c === '"') {
      inWord = curQuoted = true;
      i++;
      while (i < n && src[i] !== '"') {
        const d = src[i]!;
        if (d === "\\" && i + 1 < n) {
          const nx = src[i + 1]!;
          cur += /["\\$`]/.test(nx) ? nx : `\\${nx}`;
          i += 2;
        } else if (d === "$" && src[i + 1] === "(") {
          const e = matchParen(src, i + 1);
          if (e === -1) {
            cur += src.slice(i);
            i = n;
          } else {
            subs.push(src.slice(i + 2, e));
            cur += "$(…)";
            i = e + 1;
          }
        } else if (d === "`") {
          const e = src.indexOf("`", i + 1);
          subs.push(src.slice(i + 1, e === -1 ? n : e));
          cur += "`…`";
          i = e === -1 ? n : e + 1;
        } else {
          cur += d;
          i++;
        }
      }
      i++;
    } else if (c === "$" && src[i + 1] === "(") {
      const e = matchParen(src, i + 1);
      inWord = true;
      if (e === -1) {
        cur += src.slice(i);
        i = n;
      } else {
        subs.push(src.slice(i + 2, e));
        cur += "$(…)";
        i = e + 1;
      }
    } else if (c === "`") {
      const e = src.indexOf("`", i + 1);
      subs.push(src.slice(i + 1, e === -1 ? n : e));
      cur += "`…`";
      inWord = true;
      i = e === -1 ? n : e + 1;
    } else if ((c === "<" || c === ">") && src[i + 1] === "(") {
      const e = matchParen(src, i + 1);
      inWord = true;
      if (e === -1) {
        cur += src.slice(i);
        i = n;
      } else {
        subs.push(src.slice(i + 2, e));
        cur += `${c}(…)`;
        i = e + 1;
      }
    } else if (c === "#" && !inWord) {
      const e = src.indexOf("\n", i);
      i = e === -1 ? n : e;
    } else if (c === ">" || c === "<" || (c === "&" && src[i + 1] === ">")) {
      // An unquoted redirect operator, with an optional file descriptor in front (2>, 1>>).
      let fd = "";
      if (inWord && !curQuoted && /^\d+$/.test(cur)) {
        fd = cur;
        cur = "";
        inWord = false;
      } else pushWord();
      let opText: string;
      if (c === "&") opText = src[i + 2] === ">" ? "&>>" : "&>";
      else {
        const three = src.slice(i, i + 3);
        const two = src.slice(i, i + 2);
        opText =
          three === "<<<" || three === "<<-"
            ? three
            : ["<<", ">>", ">&", "<&", ">|", "<>"].includes(two)
              ? two
              : c;
      }
      i += opText.length;
      const canon = opText.startsWith("&>") ? opText.slice(1) : opText;
      words.push({ text: `${fd}${canon}`, quoted: false, op: true });
    } else if (c === "\n") {
      finishCmd(i, ";");
      i++;
      segStart = i;
      // Heredoc bodies start on the line after the one that declared them.
      for (const p of pendingHeredocs.splice(0)) {
        const lines: string[] = [];
        while (i < n) {
          const e = src.indexOf("\n", i);
          const line = e === -1 ? src.slice(i) : src.slice(i, e);
          i = e === -1 ? n : e + 1;
          if ((p.strip ? line.trim() : line) === p.delim) break;
          lines.push(line);
        }
        p.cmd.heredoc = lines.join("\n");
        segStart = i;
      }
    } else if (c === ";") {
      finishCmd(i, ";");
      i++;
      segStart = i;
    } else if (c === "&" && src[i + 1] === "&") {
      finishCmd(i, "&&");
      i += 2;
      segStart = i;
    } else if (c === "|" && src[i + 1] === "|") {
      finishCmd(i, "||");
      i += 2;
      segStart = i;
    } else if (c === "|") {
      finishCmd(i, "|");
      i += src[i + 1] === "&" ? 2 : 1;
      segStart = i;
    } else if (c === "&") {
      finishCmd(i, "&");
      i++;
      segStart = i;
    } else if (c === "(" || c === ")") {
      // A subshell or group: its contents are commands of the same list.
      finishCmd(i, ";");
      i++;
      segStart = i;
    } else if (c === " " || c === "\t" || c === "\r") {
      pushWord();
      i++;
    } else {
      cur += c;
      inWord = true;
      i++;
    }
  }
  finishCmd(n, null);

  // Substitutions become commands of their own, attributed to the command that held them.
  for (const s of subQueue) {
    if (depth >= MAX_DEPTH || out.length >= MAX_COMMANDS) break;
    for (const c of parseShell(s.code, depth + 1))
      out.push({ ...c, substitutionOf: s.owner, depth: depth + 1 });
  }
  return out;
}
