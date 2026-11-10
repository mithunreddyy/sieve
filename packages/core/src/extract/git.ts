import type { Extractor } from "./types.ts";
import { cmdMatches, compact, lines, plural } from "./util.ts";

// ---------------------------------------------------------------- diff
const GENERATED =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|composer\.lock|Gemfile\.lock|flake\.lock)$|\.min\.(js|css)$|\.map$|(^|\/)(dist|build|vendor|__snapshots__)\/|\.snap$/;

interface FileDiff {
  path: string;
  lines: string[];
  add: number;
  del: number;
  binary: boolean;
}

function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  for (const l of lines(text)) {
    if (l.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
      cur = { path: m?.[2] ?? l.slice(11), lines: [l], add: 0, del: 0, binary: false };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.lines.push(l);
    if (l.startsWith("+") && !l.startsWith("+++")) cur.add++;
    else if (l.startsWith("-") && !l.startsWith("---")) cur.del++;
    else if (/^Binary files /.test(l)) cur.binary = true;
  }
  return files;
}

/**
 * Hunks are kept whole, in order, until the budget is used; after that a file is listed
 * with its counts and its hunks stay in the archive. Lockfiles, minified and generated
 * files are always listed by counts only.
 */
export const gitDiff: Extractor = {
  id: "git-diff",
  detect: ({ command, text }) =>
    /^diff --git a\//m.test(text.slice(0, 4000))
      ? cmdMatches(command, /\bgit\s+(diff|show)\b/)
        ? 95
        : 85
      : 0,
  extract({ text, budget }) {
    const files = parseDiff(text);
    if (!files.length) return null;
    const out: string[] = [];
    const stat: string[] = [];
    let used = 0;
    let generated = 0;
    let overBudget = 0;
    for (const f of files) {
      const size = f.lines.reduce((n, l) => n + l.length + 1, 0);
      const counts = f.binary ? "binary" : `+${f.add} −${f.del}`;
      if (GENERATED.test(f.path) || f.binary) {
        stat.push(`  ${f.path}  ${counts}  (generated or binary: hunks not shown)`);
        generated++;
      } else if (used + size > budget && used > 0) {
        stat.push(`  ${f.path}  ${counts}  (over budget: hunks in the archive)`);
        overBudget++;
      } else {
        stat.push(`  ${f.path}  ${counts}`);
        out.push(...f.lines);
        used += size;
      }
    }
    const add = files.reduce((n, f) => n + f.add, 0);
    const del = files.reduce((n, f) => n + f.del, 0);
    const head = [`${plural(files.length, "file")} changed, +${add} −${del}`, ...stat];
    return {
      extractor: "git-diff",
      body: [...head, "", ...out].join("\n").trimEnd(),
      dropped: compact([
        generated > 0 && `hunks of ${plural(generated, "generated or binary file")}`,
        overBudget > 0 && `hunks of ${plural(overBudget, "file")} past the budget`,
      ]),
      keptVerbatim: false,
    };
  },
};

// ---------------------------------------------------------------- log
export const gitLog: Extractor = {
  id: "git-log",
  detect: ({ command, text }) =>
    /^commit [0-9a-f]{7,40}\b/m.test(text.slice(0, 200)) && /^(Author|Date):/m.test(text.slice(0, 1000))
      ? cmdMatches(command, /\bgit\s+log\b/)
        ? 95
        : 85
      : 0,
  extract({ text }) {
    const commits: Array<{
      hash: string;
      author: string;
      date: string;
      subject: string;
      body: number;
      files: string[];
      stat: string;
      merge: boolean;
    }> = [];
    let c: (typeof commits)[number] | null = null;
    for (const l of lines(text)) {
      const m = /^commit ([0-9a-f]{7,40})/.exec(l);
      if (m) {
        c = {
          hash: m[1]!.slice(0, 10),
          author: "",
          date: "",
          subject: "",
          body: 0,
          files: [],
          stat: "",
          merge: false,
        };
        commits.push(c);
        continue;
      }
      if (!c) continue;
      if (l.startsWith("Author:"))
        c.author = l
          .slice(7)
          .trim()
          .replace(/\s*<[^>]*>$/, "");
      else if (l.startsWith("Date:")) {
        const d = l.slice(5).trim();
        const dm = /^\w{3} (\w{3}) (\d{1,2}) [\d:]+ (\d{4})/.exec(d);
        const mon = dm
          ? String("JanFebMarAprMayJunJulAugSepOctNovDec".indexOf(dm[1]!) / 3 + 1).padStart(2, "0")
          : "";
        c.date = dm ? `${dm[3]}-${mon}-${dm[2]!.padStart(2, "0")}` : d;
      } else if (l.startsWith("Merge:")) c.merge = true;
      else if (/^ {4}\S/.test(l)) {
        if (!c.subject) c.subject = l.trim();
        else c.body++;
      } else if (/^ {4}$/.test(l) && c.subject) c.body++;
      else if (/^ \S.* \| +(\d+|Bin)/.test(l)) c.files.push(l.trim().split(/\s+\|/)[0]!);
      else if (/^ \d+ files? changed/.test(l)) c.stat = l.trim();
    }
    if (!commits.length) return null;
    const authors = new Map<string, number>();
    for (const x of commits) authors.set(x.author, (authors.get(x.author) ?? 0) + 1);
    const top = [...authors].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const out = [
      `${plural(commits.length, "commit")}${commits.length > 1 ? `, ${commits[commits.length - 1]!.date} → ${commits[0]!.date}` : ""}; authors: ${top.map(([a, n]) => `${a} (${n})`).join(", ")}`,
      "",
      ...commits.map((x) => {
        const files = x.files.length
          ? ` [${x.stat || plural(x.files.length, "file")}${x.files.length <= 4 ? `: ${x.files.join(", ")}` : ""}]`
          : "";
        return `${x.hash} ${x.date} ${x.author}${x.merge ? " (merge)" : ""}: ${x.subject}${x.body ? ` (+${plural(x.body, "body line")})` : ""}${files}`;
      }),
    ];
    const bodies = commits.reduce((n, x) => n + x.body, 0);
    return {
      extractor: "git-log",
      body: out.join("\n"),
      dropped: compact([
        bodies > 0 && plural(bodies, "commit message body line"),
        commits.some((x) => x.files.length > 4) && "per-file stat lines of large commits",
        "emails and times",
      ]),
      keptVerbatim: false,
    };
  },
};

// ---------------------------------------------------------------- status
export const gitStatus: Extractor = {
  id: "git-status",
  detect: ({ command, text }) =>
    cmdMatches(command, /\bgit\s+status\b/)
      ? 95
      : /^(On branch |HEAD detached |Changes (not staged|to be committed)|Untracked files:)/m.test(
            text.slice(0, 2000),
          )
        ? 85
        : 0,
  extract({ text }) {
    const out: string[] = [];
    const groups = new Map<string, string[]>();
    const order: string[] = [];
    let section = "";
    let hints = 0;
    const add = (state: string, path: string) => {
      if (!groups.has(state)) {
        groups.set(state, []);
        order.push(state);
      }
      groups.get(state)!.push(path);
    };
    for (const l of lines(text)) {
      if (/^\s+\(use "git /.test(l) || /^\s+\(commit or discard/.test(l)) {
        hints++;
        continue;
      }
      if (
        /^(Changes to be committed|Changes not staged for commit|Untracked files|Unmerged paths|Ignored files):$/.test(
          l,
        )
      ) {
        section = l
          .slice(0, -1)
          .replace("Changes not staged for commit", "unstaged")
          .replace("Changes to be committed", "staged")
          .toLowerCase();
        continue;
      }
      const m =
        /^\t(?:(new file|modified|deleted|renamed|copied|typechange|both modified|both added|deleted by us|deleted by them):\s+)?(.+)$/.exec(
          l,
        );
      if (m && section) {
        add(`${section}${m[1] ? ` ${m[1]}` : ""}`, m[2]!);
        continue;
      }
      const s = /^([ MADRCU?!]{2}) (.+)$/.exec(l); // --short / --porcelain
      if (s && !section) {
        add(s[1]!.trim() === "??" ? "untracked" : `[${s[1]}]`, s[2]!);
        continue;
      }
      if (l.trim()) out.push(l);
    }
    if (!groups.size) return null;
    for (const state of order) {
      const paths = groups.get(state)!;
      out.push("", `${state} (${paths.length}):`);
      // Group by directory so long lists stay readable; every path is still listed.
      const byDir = new Map<string, string[]>();
      for (const p of paths) {
        const i = p.lastIndexOf("/", p.endsWith("/") ? p.length - 2 : p.length);
        const dir = i === -1 ? "" : p.slice(0, i + 1);
        if (!byDir.has(dir)) byDir.set(dir, []);
        byDir.get(dir)!.push(p.slice(dir.length));
      }
      for (const [dir, names] of byDir)
        out.push(`  ${dir || "./"}${names.length > 1 ? ` (${names.length})` : ""}: ${names.join(", ")}`);
    }
    return {
      extractor: "git-status",
      body: out.join("\n").trim(),
      dropped: compact([hints > 0 && plural(hints, "hint line")]),
      keptVerbatim: false,
    };
  },
};

export const GIT_EXTRACTORS: Extractor[] = [gitDiff, gitLog, gitStatus];
