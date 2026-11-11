import { loadConfig } from "@sieve/core";
import { startProxy } from "@sieve/proxy";

/** `sieve proxy [--port N]` (slice 10): the local gateway. Runs until stopped. */

export async function proxyCommand(args: string[]): Promise<number> {
  const i = args.indexOf("--port");
  const port = i === -1 ? undefined : Number(args[i + 1]);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    console.error("usage: sieve proxy [--port N]");
    return 2;
  }
  const cfg = loadConfig();
  const p = startProxy({ ...(port ? { port } : {}), config: cfg });
  const c = cfg.proxy;
  console.log(
    `Sieve proxy on ${p.url}. Your client keeps its own key; it is sent on to the upstream and not stored.`,
  );
  console.log("Point a client at it:");
  console.log(`  Claude Code / Anthropic SDK   ANTHROPIC_BASE_URL=${p.url}   → ${c.anthropic_upstream}`);
  console.log(`  Codex / OpenAI-compatible     OPENAI_BASE_URL=${p.url}/v1   → ${c.openai_upstream}`);
  console.log(`  Gemini                        base URL ${p.url}   → ${c.gemini_upstream}`);
  console.log(
    `Doing: trim tool descriptions over ${c.trim_description_bytes} B${c.trim_tools ? "" : " (off)"}; receipts for tool results over ${c.fold_result_bytes} B${c.fold_history ? "" : " (off)"}; cache marks in free slots${c.add_cache_marks ? "" : " (off)"}.`,
  );
  const caps = [
    c.session_tokens && `${c.session_tokens.toLocaleString("en-US")} tokens/session`,
    c.day_tokens && `${c.day_tokens.toLocaleString("en-US")} tokens/day`,
    c.session_dollars && `$${c.session_dollars}/session`,
    c.day_dollars && `$${c.day_dollars}/day`,
  ].filter(Boolean);
  console.log(
    `Budgets: ${caps.length ? `${caps.join(", ")}; ${c.hard_stop ? "hard stop on" : "warnings only"}` : "none set"}.`,
  );
  if (!["127.0.0.1", "localhost", "::1"].includes(c.host))
    console.log(
      `! Listening on ${c.host}, not just this machine. The proxy has no login of its own: put TLS and authentication in front of it, or anyone who can reach it can send requests through it.`,
    );
  console.log("Ctrl-C stops it.");
  return new Promise<number>(() => {});
}
