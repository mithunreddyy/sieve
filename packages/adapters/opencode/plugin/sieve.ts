// Sieve plugin for OpenCode, written by `sieve setup --agents opencode`.
// Remove it with `sieve setup --agents opencode --remove` (or delete this file).
//
// It runs inside OpenCode, forwards each hook to the local Sieve daemon over its Unix socket,
// and applies the reply. Like the hook shim it never blocks or fails OpenCode: any error, a
// slow daemon (over SIEVE_HOOK_TIMEOUT_MS, default 250 ms) or no daemon means "no change", and
// a line in ~/.sieve/run/misses.log. Nothing here talks to the network.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const SIEVE_BIN = "__SIEVE_BIN__";
const PROTOCOL = 1;
const CLIENT = "sieve-opencode/0.1.0";

const home = () => process.env.SIEVE_HOME || join(homedir(), ".sieve");
const budget = () => {
  const n = Number(process.env.SIEVE_HOOK_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 250;
};

function miss(event: string, reason: string): void {
  try {
    mkdirSync(join(home(), "run"), { recursive: true, mode: 0o700 });
    appendFileSync(join(home(), "run", "misses.log"), `${Date.now()}\topencode\t${event}\t${reason}\n`, {
      mode: 0o600,
    });
  } catch {}
}

let lastSpawn = 0;
function startDaemon(): void {
  const bin = process.env.SIEVE_BIN || SIEVE_BIN;
  if (!bin || bin.startsWith("__") || Date.now() - lastSpawn < 60_000) return;
  lastSpawn = Date.now();
  try {
    const child = spawn(bin, ["daemon", "run"], { detached: true, stdio: "ignore" });
    // A missing binary is reported as an event, not a throw: unhandled, it would crash OpenCode.
    child.on("error", () => miss("spawn", "daemon-start-failed"));
    child.unref();
  } catch {}
}

interface Reply {
  context?: string;
  replaceOutput?: string;
  deny?: string;
}

/** One hook round trip. Resolves null on any problem (the caller then changes nothing). */
function call(event: string, input: Record<string, unknown>): Promise<Reply | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: Reply | null, why?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (why) miss(event, why);
      resolve(r);
    };
    const sock = connect(join(home(), "run", "sieved.sock"));
    const timer = setTimeout(() => finish(null, "timeout"), budget());
    let buf = "";
    sock.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
        finish(null, "daemon-down");
        startDaemon();
      } else finish(null, "socket-error");
    });
    sock.on("connect", () => {
      sock.write(
        `${JSON.stringify({ v: PROTOCOL, id: "o", type: "hook", client: CLIENT, budgetMs: budget(), agent: "opencode", event, input })}\n`,
      );
    });
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      try {
        const reply = JSON.parse(buf.slice(0, nl));
        if (!reply.ok) return finish(null, reply.error?.code ?? "error");
        const out = reply.result?.stdout;
        finish(out ? (JSON.parse(out) as Reply) : {});
      } catch {
        finish(null, "bad-reply");
      }
    });
  });
}

/** OpenCode's ascending part id: 12 hex digits of (ms × 4096 + counter), then 14 random base62. */
let lastMs = 0;
let counter = 0;
function partId(): string {
  const now = Date.now();
  if (now !== lastMs) {
    lastMs = now;
    counter = 0;
  }
  counter++;
  const n = BigInt(now) * 0x1000n + BigInt(counter);
  let hex = "";
  for (let i = 0; i < 6; i++)
    hex += Number((n >> BigInt(40 - 8 * i)) & 0xffn)
      .toString(16)
      .padStart(2, "0");
  const abc = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(14)), (b) => abc[b % 62]).join("");
  return `prt_${hex}${rand}`;
}

type Ctx = { directory?: string; worktree?: string };
type EventProps = { sessionID?: string; info?: { id?: string; directory?: string; parentID?: string } };
type Part = { type?: string; text?: string; synthetic?: boolean };

export const SievePlugin = async (ctx: Ctx) => {
  const cwd = ctx.directory || ctx.worktree || process.cwd();
  return {
    event: async ({ event }: { event: { type: string; properties?: EventProps } }) => {
      const p = event.properties ?? {};
      const sessionID = p.sessionID ?? p.info?.id;
      if (!sessionID) return;
      if (["session.created", "session.idle", "session.compacted", "session.deleted"].includes(event.type))
        await call(event.type, { sessionID, cwd: p.info?.directory || cwd, parentID: p.info?.parentID });
    },
    "chat.message": async (
      input: { sessionID: string },
      output: { message: { id: string }; parts: Part[] },
    ) => {
      const prompt = output.parts
        .filter((x) => x.type === "text" && !x.synthetic && typeof x.text === "string")
        .map((x) => x.text)
        .join("\n");
      const r = await call("chat.message", { sessionID: input.sessionID, cwd, prompt });
      if (r?.context)
        output.parts.push({
          id: partId(),
          sessionID: input.sessionID,
          messageID: output.message.id,
          type: "text",
          text: r.context,
          synthetic: true,
        } as Part);
    },
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID?: string },
      output: { args: unknown },
    ) => {
      const r = await call("tool.execute.before", {
        sessionID: input.sessionID,
        cwd,
        tool: input.tool,
        args: output.args,
      });
      // Throwing is how an OpenCode plugin declines a tool call; the message reaches the model.
      if (r?.deny) throw new Error(r.deny);
    },
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID?: string; args: unknown },
      output: { title: string; output: string; metadata: unknown },
    ) => {
      if (typeof output.output !== "string") return;
      const r = await call("tool.execute.after", {
        sessionID: input.sessionID,
        cwd,
        tool: input.tool,
        args: input.args,
        output: output.output,
        metadata: output.metadata,
      });
      if (typeof r?.replaceOutput === "string") output.output = r.replaceOutput;
    },
    "experimental.session.compacting": async (
      input: { sessionID: string },
      output: { context: string[] },
    ) => {
      const r = await call("session.compacting", { sessionID: input.sessionID, cwd });
      if (r?.context) output.context.push(r.context);
    },
  };
};
