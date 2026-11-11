import type { Snapshot } from "./data.ts";

/** The terminal view (`sieve tui`): one frame of text from a snapshot. Pure, so it can be tested. */

const n = (x: number) => x.toLocaleString("en-US");
const pad = (s: string, w: number) => (s.length > w ? `${s.slice(0, Math.max(0, w - 1))}…` : s.padEnd(w));
const rpad = (s: string, w: number) => s.padStart(w);
const ago = (t: number, now: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 90
    ? `${s}s`
    : s < 5400
      ? `${Math.round(s / 60)}m`
      : s < 129600
        ? `${Math.round(s / 3600)}h`
        : `${Math.round(s / 86400)}d`;
};

export function renderFrame(
  d: Snapshot,
  opts: { width?: number; color?: boolean; daemon?: { up: boolean; line?: string } } = {},
): string {
  const w = Math.max(60, Math.min(opts.width ?? 100, 140));
  const c = opts.color ?? false;
  const bold = (s: string) => (c ? `\x1b[1m${s}\x1b[0m` : s);
  const dim = (s: string) => (c ? `\x1b[2m${s}\x1b[0m` : s);
  const red = (s: string) => (c ? `\x1b[31m${s}\x1b[0m` : s);
  const rule = dim("─".repeat(w));
  const t = d.totals;
  const out: string[] = [];
  out.push(
    `${bold("Sieve")}  ${opts.daemon ? (opts.daemon.up ? "daemon up" : red("daemon not running")) : ""}${opts.daemon?.line ? `  ${dim(opts.daemon.line)}` : ""}`,
  );
  out.push(
    `${bold(`${t.savedPct}% fewer`)} tokens: ${n(t.tokensIn)} in → ${n(t.tokensOut)} returned over ${n(t.folds)} shortened output(s)  ·  ~$${d.dollars.saved.toFixed(2)} at $${d.dollars.perMillionInput}/M ${dim("(estimate)")}  ·  cache hits ${d.cacheHitRate == null ? dim("not measured") : `${Math.round(d.cacheHitRate * 100)}%`}`,
  );
  out.push(rule);
  const table = (title: string, rows: string[]) => {
    out.push(bold(title));
    out.push(...(rows.length ? rows : [dim("  nothing yet")]));
  };
  const bucketRow = (b: { key: string; count: number; tokensIn: number; tokensOut: number }) =>
    `  ${pad(b.key, 22)} ${rpad(n(b.count), 6)} outputs  ${rpad(n(b.tokensIn), 10)} → ${rpad(n(b.tokensOut), 9)}`;
  table("By agent", d.byAgent.slice(0, 6).map(bucketRow));
  table("By extractor", d.byExtractor.slice(0, 6).map(bucketRow));
  out.push(rule);
  table(
    "Latest receipts",
    d.receipts
      .slice(0, 8)
      .map(
        (r) =>
          `  ${rpad(ago(r.at, d.generatedAt), 4)} ${pad(r.agent, 12)} ${pad(r.tool, 8)} ${pad(`${r.kind}${r.extractor ? `/${r.extractor}` : ""}`, 18)} ${rpad(n(r.tokensIn), 8)} → ${rpad(n(r.tokensOut), 7)}  ${dim(r.archiveId ?? "")}`,
      ),
  );
  out.push(rule);
  table(
    "Guard",
    d.guard
      .slice(0, 5)
      .map(
        (g) =>
          `  ${rpad(ago(g.at, d.generatedAt), 4)} ${/deny/.test(g.decision) ? red(pad(g.decision, 12)) : pad(g.decision, 12)} ${pad(g.rule ?? "", 34)} ${pad(`${g.tool}${g.program ? ` ${g.program}` : ""}`, 20)}`,
      ),
  );
  table(
    "Hooks",
    d.hooks
      .slice(0, 8)
      .map(
        (h) =>
          `  ${pad(h.agent, 14)} ${pad(h.event, 22)} last ${rpad(ago(h.lastAt, d.generatedAt), 4)} ago  ${rpad(n(h.count), 8)}x`,
      ),
  );
  out.push(rule);
  out.push(dim(`${n(d.facts.length)} memory fact(s) · ${d.projects.length} project(s) · q quits`));
  return out.join("\n");
}
