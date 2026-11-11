// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences is the point
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Remove ANSI escapes and collapse carriage-return redraws (progress bars) so only the
 * final state of each line remains. Never drops printable content otherwise.
 */
export function cleanTerminal(text: string): string {
  let out = text.includes("\x1b") ? text.replace(ANSI, "") : text;
  if (out.includes("\r")) {
    out = out
      .split("\n")
      .map((line) => {
        const l = line.endsWith("\r") ? line.slice(0, -1) : line;
        const i = l.lastIndexOf("\r");
        return i === -1 ? l : l.slice(i + 1);
      })
      .join("\n");
  }
  return out;
}

export function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export function countLines(s: string): number {
  if (s.length === 0) return 0;
  let n = 1;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) n++;
  return s.endsWith("\n") ? n - 1 : n;
}

export function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

/** A coarse age ("12s ago", "5m ago", "3h ago", "2d ago"). */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
